import React from 'react';
import { getDefaultStore } from 'jotai';
import { render, screen, act } from '@testing-library/react';
import { throughputSamplesFamily, settledThroughputAtom } from '~/store/usage';
import Throughput from '~/components/Chat/Messages/Throughput';

const mockStartupConfig = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockStartupConfig(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
}));

const CONVO = 'convo-throughput';

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe('Throughput', () => {
  const store = getDefaultStore();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    mockStartupConfig.mockReturnValue({ data: { interface: { tokenThroughput: true } } });
    store.set(throughputSamplesFamily(CONVO), []);
    store.set(settledThroughputAtom, new Map());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('mounts nothing until the deployment enables the flag', () => {
    mockStartupConfig.mockReturnValue({ data: { interface: { contextUsage: true } } });
    store.set(throughputSamplesFamily(CONVO), [
      { at: 9_000, tokens: 0 },
      { at: 10_000, tokens: 50 },
    ]);
    const { container } = render(
      <Throughput conversationId={CONVO} messageId="r1" streaming={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('mounts nothing while config is still loading', () => {
    mockStartupConfig.mockReturnValue({ data: undefined });
    const { container } = render(
      <Throughput conversationId={CONVO} messageId="r1" streaming={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing before the first token lands', () => {
    const { container } = render(
      <Throughput conversationId={CONVO} messageId="r1" streaming={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the live rate and sparkline from the sampled readings', () => {
    render(<Throughput conversationId={CONVO} messageId="r1" streaming={true} />);
    act(() => {
      store.set(throughputSamplesFamily(CONVO), [
        { at: 9_000, tokens: 0 },
        { at: 10_000, tokens: 60 },
      ]);
    });
    /** The first tick lands after one interval: 60 tokens over the 1 s span */
    advance(500);
    const reading = screen.getByTestId('stream-throughput');
    expect(reading).toHaveTextContent('com_ui_throughput_rate:40');
    expect(reading.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(reading.querySelector('polyline')?.getAttribute('points')).toBeTruthy();
    expect(screen.getByText('com_ui_throughput_live_announced:40')).toHaveClass('sr-only');
    /** The visible reading shimmers like the elapsed timer beside it */
    expect(screen.getByText('com_ui_throughput_rate:40')).toHaveClass('shimmer');
  });

  it('decays the live rate toward zero when the stream stalls', () => {
    store.set(throughputSamplesFamily(CONVO), [
      { at: 9_000, tokens: 0 },
      { at: 10_000, tokens: 100 },
    ]);
    render(<Throughput conversationId={CONVO} messageId="r1" streaming={true} />);
    advance(500);
    expect(screen.getByTestId('stream-throughput')).toHaveTextContent('com_ui_throughput_rate:67');
    advance(3_000);
    expect(screen.getByTestId('stream-throughput')).toHaveTextContent('com_ui_throughput_rate:0.0');
  });

  it('shows the settled average under the response it belongs to only', () => {
    store.set(
      settledThroughputAtom,
      new Map([
        [
          'r1',
          { responseId: 'r1', outputTokens: 300, durationMs: 6_000, ttftMs: 800, estimated: false },
        ],
      ]),
    );
    const { rerender } = render(
      <Throughput conversationId={CONVO} messageId="r1" streaming={false} />,
    );
    const settled = screen.getByTestId('settled-throughput');
    expect(settled).toHaveTextContent('com_ui_throughput_rate:50');
    expect(settled).toHaveAttribute('aria-hidden', 'true');
    expect(
      screen.getByText('com_ui_throughput_settled_label:50,300,6.0 com_ui_throughput_ttft:0.8'),
    ).toHaveClass('sr-only');

    rerender(<Throughput conversationId={CONVO} messageId="r2" streaming={false} />);
    expect(screen.queryByTestId('settled-throughput')).toBeNull();
  });

  it('marks an estimated settled reading and omits an unknown TTFT', () => {
    store.set(
      settledThroughputAtom,
      new Map([
        [
          'r1',
          { responseId: 'r1', outputTokens: 40, durationMs: 8_000, ttftMs: null, estimated: true },
        ],
      ]),
    );
    render(<Throughput conversationId={CONVO} messageId="r1" streaming={false} />);
    const settled = screen.getByTestId('settled-throughput');
    expect(settled).toHaveTextContent('com_ui_throughput_rate_estimated:5.0');
    expect(
      screen.getByText('com_ui_throughput_settled_label:5.0,40,8.0 com_ui_throughput_estimated'),
    ).toHaveClass('sr-only');
  });
});
