import { render, screen } from '@testing-library/react';
import Dropdown from './Dropdown';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const OPTIONS = [
  { value: 'system', label: 'System' },
  { value: '12h', label: '12-hour' },
  { value: '24h', label: '24-hour' },
];

describe('Dropdown accessible name', () => {
  it('announces the selected value alongside the field label', () => {
    // `aria-labelledby` REPLACES the trigger's child text, and that text is the
    // selected option: pointing it at the field label alone announced "Clock Format"
    // with no way to hear which format was selected.
    render(
      <>
        <span id="clock-label">{'Clock Format'}</span>
        <Dropdown value="24h" options={OPTIONS} aria-labelledby="clock-label" />
      </>,
    );

    expect(screen.getByRole('combobox', { name: 'Clock Format 24-hour' })).toBeInTheDocument();
  });

  it('does not reference the value span in iconOnly mode, where it never renders', () => {
    // Appending the span's id unconditionally left a dangling token in the
    // accessible-name computation whenever `iconOnly` dropped the span.
    render(
      <>
        <span id="clock-label">{'Clock Format'}</span>
        <Dropdown value="24h" options={OPTIONS} aria-labelledby="clock-label" iconOnly />
      </>,
    );

    const trigger = screen.getByRole('combobox', { name: 'Clock Format' });
    expect(trigger.getAttribute('aria-labelledby')).toBe('clock-label');
  });

  it('falls back to the value alone when no label is supplied', () => {
    render(<Dropdown value="12h" options={OPTIONS} ariaLabel="Clock Format" />);

    // `ariaLabel` names it outright, so the labelled-by relationship stays off.
    expect(screen.getByRole('combobox', { name: 'Clock Format' })).toBeInTheDocument();
  });
});

describe('Dropdown shape', () => {
  const trigger = () => screen.getByRole('combobox', { name: 'Clock Format' });

  it('draws the trigger at the theme control radius when no shape is given', () => {
    render(<Dropdown value="12h" options={OPTIONS} ariaLabel="Clock Format" />);

    expect(trigger()).toHaveClass('rounded-theme-control');
    expect(trigger()).not.toHaveClass('rounded-xl');
  });

  it.each([
    ['default', 'rounded-lg'],
    ['theme', 'rounded-theme-control'],
    ['round', 'rounded-theme-control-round'],
  ] as const)('maps shape="%s" to %s, as Button does', (shape, radius) => {
    render(
      <Dropdown value="12h" options={OPTIONS} ariaLabel="Clock Format" shape={shape} disabled />,
    );

    expect(trigger()).toHaveClass(radius);
  });

  it('keeps the field radius on a field trigger whatever the shape', () => {
    render(
      <Dropdown
        value="12h"
        options={OPTIONS}
        ariaLabel="Clock Format"
        variant="field"
        shape="round"
      />,
    );

    expect(trigger()).toHaveClass('rounded-lg');
    expect(trigger()).not.toHaveClass('rounded-theme-control-round');
  });
});
