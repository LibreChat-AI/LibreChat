/** @jest-environment jsdom */
import { createRef } from 'react';
import { writeFileSync } from 'node:fs';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import type { ToolGroupHeaderProps } from '../Header';
import { initEnglish } from '../../../../__fixtures__/i18n';
import { useRailHover } from '../../rail';
import Header from '../Header';

beforeAll(initEnglish);

const defaults = {
  label: 'Created the config files',
  detail: 'Create File',
  ariaLabel: 'Created the config files, Create File, Thoughts',
  expanded: false,
  hidden: false,
  animate: false,
  glyph: <svg className="size-4" data-testid="glyph" />,
  headerRef: createRef<HTMLDivElement>(),
  actionSlotRef: createRef<HTMLSpanElement>(),
  onToggle: jest.fn(),
} satisfies Omit<ToolGroupHeaderProps, 'hover'>;

function Harness(props: Partial<ToolGroupHeaderProps>) {
  const hover = useRailHover();
  return <Header {...defaults} hover={hover} {...props} />;
}

describe('ToolGroupHeader', () => {
  it('exports the real group header for the browser cascade checks', () => {
    const { container } = render(<Harness expanded />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    const fixturePath = process.env.E2E_TOOL_GROUP_CASCADE_FIXTURE;
    if (fixturePath) {
      writeFileSync(fixturePath, container.innerHTML);
    }
  });

  it('preserves the accessible name, status, titles and sibling action target without a host', () => {
    render(<Harness />);
    const button = screen.getByRole('button', { name: defaults.ariaLabel });
    const header = defaults.headerRef.current;
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(header?.firstElementChild).toBe(button);
    expect(header?.lastElementChild).toBe(defaults.actionSlotRef.current);
    expect(button).not.toContainElement(defaults.actionSlotRef.current);
    expect(screen.getByRole('status')).toHaveAttribute('title', defaults.label);
    expect(screen.getByTitle(defaults.detail)).toHaveClass('max-w-2/5');
    expect(screen.getByTestId('glyph').closest('[aria-hidden]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });

  it('keeps the group disclosure chevron visible', () => {
    render(<Harness />);
    const chevron = screen.getByRole('button').lastElementChild;
    expect(chevron).not.toHaveClass('opacity-0', 'rotate-180');
    expect(chevron).toHaveAttribute('aria-hidden', 'true');
  });

  it('supports keyboard activation and controlled updates without remounting the refs', async () => {
    const onToggle = jest.fn();
    const { rerender } = render(<Harness onToggle={onToggle} />);
    const button = screen.getByRole('button');
    const header = defaults.headerRef.current;
    const actions = defaults.actionSlotRef.current;
    button.focus();
    await userEvent.keyboard('{Enter} ');
    expect(onToggle).toHaveBeenCalledTimes(2);
    rerender(<Harness expanded onToggle={onToggle} />);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button.lastElementChild).toHaveClass('rotate-180');
    expect(defaults.headerRef.current).toBe(header);
    expect(defaults.actionSlotRef.current).toBe(actions);
  });

  it('keeps flattened headers mounted and hidden without hiding their caller', () => {
    const { container } = render(<Harness hidden />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(defaults.headerRef.current).toHaveAttribute('hidden');
    expect(defaults.headerRef.current).toHaveClass('hidden');
    expect(defaults.headerRef.current?.parentElement).toBe(container);
    expect(defaults.actionSlotRef.current).toBeInTheDocument();
  });

  it('reveals failures from a sibling button without toggling the disclosure', async () => {
    const onReveal = jest.fn();
    const onToggle = jest.fn();
    render(<Harness onToggle={onToggle} failure={{ count: 1, total: 2, onReveal }} />);
    const disclosure = screen.getByRole('button', { name: defaults.ariaLabel });
    const failure = screen.getByTestId('failed-reveal-pill');
    expect(disclosure).not.toContainElement(failure);
    expect(failure.parentElement).toBe(disclosure.parentElement);
    await userEvent.click(failure);
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it.each([
    [1, 'text-text-secondary'],
    [2, 'text-status-error'],
  ])('uses the failure count tone for %i of two failures', (count, tone) => {
    render(<Harness failure={{ count, total: 2, onReveal: jest.fn() }} />);
    expect(screen.getByTestId('failed-reveal-pill').querySelector('span')).toHaveClass(tone);
  });

  it('omits empty details and failure controls owned by a parent', () => {
    render(<Harness detail="" />);
    expect(screen.queryByTitle(defaults.detail)).toBeNull();
    expect(screen.queryByTestId('failed-reveal-pill')).toBeNull();
  });
});
