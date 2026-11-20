/** @jest-environment jsdom */
import { useEffect } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { ToolGroupBodyProps } from '../Body';
import { createMessagePartsHost } from '../../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../../react/host';
import { initEnglish } from '../../../../__fixtures__/i18n';
import Body from '../Body';

beforeAll(initEnglish);

const tool = (streamedIndex?: number): TMessageContentParts => ({
  type: ContentTypes.TEXT,
  text: 'Tool renderer content',
  streamedIndex,
});
const thought = (
  think: string | { value: string },
  reasoning_label?: string,
): TMessageContentParts =>
  ({ type: ContentTypes.THINK, think, reasoning_label }) as TMessageContentParts;
const defaults = {
  parts: [],
  isSubmitting: false,
  isLast: false,
  showThinking: false,
  smoothStreaming: true,
  lastContentIdx: 0,
  thinkingLabel: 'Thinking now',
  thoughtsLabel: 'Finished thoughts',
  renderPart: jest.fn((_part, idx) => <span key={idx}>{`Part ${idx}`}</span>),
  onToolExpand: jest.fn(),
} satisfies ToolGroupBodyProps;
const host = createMessagePartsHost();

function reasoningBody(props: Partial<ToolGroupBodyProps>) {
  return (
    <MessagePartsHostProvider host={host}>
      <Body {...defaults} {...props} />
    </MessagePartsHostProvider>
  );
}

describe('ToolGroupBody', () => {
  it('renders an empty body without an app host', () => {
    const { container } = render(<Body {...defaults} />);
    expect(container.firstElementChild).toHaveClass('flex', 'flex-col', 'py-0.5');
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });

  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ])(
    'keeps mount animation gated by submitting=%s and smoothing=%s',
    (isSubmitting, smoothStreaming, animated) => {
      const part = tool();
      render(
        <Body
          {...defaults}
          parts={[{ part, idx: 3 }]}
          isSubmitting={isSubmitting}
          smoothStreaming={smoothStreaming}
          isLast
          lastContentIdx={3}
        />,
      );
      const wrapper = screen.getByText('Part 3').parentElement;
      expect(wrapper?.className).toBe(
        animated
          ? 'animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none'
          : '',
      );
      expect(defaults.renderPart).toHaveBeenLastCalledWith(part, 3, true, defaults.onToolExpand);
    },
  );

  it('keeps stamped tool keys and child state through index compaction', () => {
    const onMount = jest.fn();
    const onUnmount = jest.fn();
    function Child() {
      useEffect(() => {
        onMount();
        return onUnmount;
      }, []);
      return <input aria-label="Tool input" defaultValue="original" />;
    }
    const renderPart = jest.fn(() => <Child />);
    const part = tool(7);
    const { rerender } = render(
      <Body {...defaults} parts={[{ part, idx: 7 }]} renderPart={renderPart} />,
    );
    const input = screen.getByRole('textbox');
    const wrapper = input.parentElement;
    fireEvent.change(input, { target: { value: 'retained draft' } });
    rerender(
      <Body {...defaults} parts={[{ part: { ...part }, idx: 1 }]} renderPart={renderPart} />,
    );
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input.parentElement).toBe(wrapper);
    expect(input).toHaveValue('retained draft');
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();
  });

  it.each([
    { type: ContentTypes.THINK, think: '', reasoning_unavailable: true },
    { type: ContentTypes.THINK, think: { value: '  ' }, reasoning_unavailable: true },
    {
      type: ContentTypes.THINK,
      think: Buffer.from(Array.from({ length: 900 }, (_, i) => (i * 37 + 3) % 256)).toString(
        'base64',
      ),
    },
  ])('delegates unreadable reasoning unchanged without an app host: %#', (part) => {
    const renderPart = jest.fn(() => <span key="marker">{'Reasoning marker'}</span>);
    const { container } = render(
      <Body
        {...defaults}
        parts={[{ part: part as TMessageContentParts, idx: 2 }]}
        isLast
        lastContentIdx={2}
        renderPart={renderPart}
      />,
    );
    expect(renderPart).toHaveBeenCalledWith(part, 2, true, defaults.onToolExpand);
    expect(container.firstElementChild?.firstElementChild).toBe(
      screen.getByText('Reasoning marker'),
    );
  });

  it.each([
    [true, true, 2, 'Thinking now', true],
    [true, false, 2, 'Finished thoughts', false],
    [false, true, 2, 'Finished thoughts', false],
    [true, true, 3, 'Finished thoughts', false],
  ])(
    'streams only the message cursor: submitting=%s last=%s cursor=%s',
    (isSubmitting, isLast, lastContentIdx, label, streaming) => {
      render(
        reasoningBody({
          parts: [{ part: thought({ value: 'Checking the result.' }), idx: 2 }],
          isSubmitting,
          isLast,
          lastContentIdx,
        }),
      );
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('streaming-thought-peek') != null).toBe(streaming);
    },
  );

  it('preserves an authored label and disclosure identity while reasoning settles', () => {
    const parts = [{ part: thought('Checking the result.', '  Result analysis  '), idx: 2 }];
    const { rerender } = render(
      reasoningBody({ parts, isSubmitting: true, isLast: true, lastContentIdx: 2 }),
    );
    const disclosure = screen.getByRole('button', { name: 'Result analysis' });
    fireEvent.click(disclosure);
    const panelId = disclosure.getAttribute('aria-controls');
    expect(screen.getByText('Checking the result.')).toBeInTheDocument();
    rerender(
      reasoningBody({
        parts: [{ part: thought('Result checked.', 'Result analysis'), idx: 2 }],
        showThinking: false,
      }),
    );
    expect(screen.getByRole('button', { name: 'Result analysis' })).toBe(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(disclosure).toHaveAttribute('aria-controls', panelId);
    expect(screen.getByText('Result checked.')).toBeInTheDocument();
  });

  it('keeps mixed row order, empty thoughts and the supplied renderer element', () => {
    const element = <span key="tool">{'Supplied tool'}</span>;
    const renderPart = jest.fn(() => element);
    const { container } = render(
      reasoningBody({
        parts: [
          { part: thought(''), idx: 0 },
          { part: tool(), idx: 1 },
          { part: thought('Readable thought', '   '), idx: 2 },
        ],
        renderPart,
        showThinking: true,
      }),
    );
    const rows = container.firstElementChild;
    expect(rows?.children).toHaveLength(2);
    expect(rows?.firstElementChild).toContainElement(screen.getByText('Supplied tool'));
    expect(rows?.lastElementChild).toContainElement(
      screen.getByRole('button', { name: 'Finished thoughts' }),
    );
    expect(renderPart).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Readable thought')).toBeInTheDocument();
  });
});
