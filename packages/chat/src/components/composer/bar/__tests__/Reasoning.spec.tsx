/**
 * @jest-environment jsdom
 */
import React from 'react';
import { ComponentTypes, ReasoningEffort } from 'librechat-data-provider';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SettingDefinition } from 'librechat-data-provider';
import { initEnglish } from '../../../../__fixtures__/i18n';
import ReasoningControl from '../Reasoning';

/**
 * The reasoning control for a budget or an ungraded setting: a trigger naming the current value,
 * a modal popover with a labelled slider (and a number field with Auto for a budget), and only
 * committed, valid, changed values handed to the host.
 */

const enumSetting: SettingDefinition = {
  key: 'reasoning_effort',
  label: 'com_endpoint_reasoning_effort',
  labelCode: true,
  description: 'com_endpoint_openai_reasoning_effort',
  descriptionCode: true,
  type: 'enum',
  component: ComponentTypes.Slider,
  default: ReasoningEffort.unset,
  options: [
    ReasoningEffort.unset,
    ReasoningEffort.minimal,
    ReasoningEffort.low,
    ReasoningEffort.medium,
    ReasoningEffort.high,
  ],
  enumMappings: {
    [ReasoningEffort.unset]: 'com_ui_auto',
    [ReasoningEffort.minimal]: 'com_ui_minimal',
    [ReasoningEffort.low]: 'com_ui_low',
    [ReasoningEffort.medium]: 'com_ui_medium',
    [ReasoningEffort.high]: 'com_ui_high',
  },
};

const budgetRange = { min: -1, positiveMin: 128, max: 32768, step: 128 };

const budgetSetting: SettingDefinition = {
  key: 'thinkingBudget',
  label: 'com_endpoint_thinking_budget',
  labelCode: true,
  description: 'com_endpoint_google_thinking_budget',
  descriptionCode: true,
  type: 'number',
  component: ComponentTypes.Input,
  range: budgetRange,
};

/** Radix's slider measures its thumb; jsdom has no ResizeObserver to measure with. */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(async () => {
  await initEnglish();
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: NoopResizeObserver,
  });
});

describe('ReasoningControl', () => {
  it('renders a compact, localized disclosure for the next message', async () => {
    render(
      <ReasoningControl
        index={0}
        setting={enumSetting}
        value={{ key: 'reasoning_effort', value: ReasoningEffort.medium }}
        onChange={jest.fn()}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'Thinking Medium',
    });

    fireEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'Reasoning Effort' })).toBeVisible();
    expect(screen.queryByText(/^Reasoning models only/)).not.toBeInTheDocument();
  });

  it('stages the next vendor-native enum value from an accessible effort scale', async () => {
    const onChange = jest.fn();
    render(
      <ReasoningControl
        index={0}
        setting={enumSetting}
        value={{ key: 'reasoning_effort', value: ReasoningEffort.medium }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Thinking/ }));
    const slider = screen.getByRole('slider', { name: 'Reasoning Effort' });
    expect(slider).toHaveAttribute('aria-valuenow', '3');
    expect(slider).toHaveAttribute('aria-valuetext', 'Medium');
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ key: 'reasoning_effort', value: 'high' }),
    );
  });

  it('renders a modal dialog with an explicit close control', () => {
    render(
      <ReasoningControl
        index={0}
        setting={enumSetting}
        value={{ key: 'reasoning_effort', value: ReasoningEffort.medium }}
        onChange={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Thinking/ }));
    const dialog = screen.getByRole('dialog', { name: 'Reasoning Effort' });

    expect(dialog).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close' })).toBeVisible();
  });

  it('keeps the page behind its popover hidden from assistive technology while open', () => {
    render(
      <>
        <button type="button">Outside</button>
        <ReasoningControl
          index={0}
          setting={enumSetting}
          value={{ key: 'reasoning_effort', value: ReasoningEffort.medium }}
          onChange={jest.fn()}
        />
      </>,
    );
    const outside = screen.getByRole('button', { name: 'Outside' });
    expect(outside).not.toHaveAttribute('aria-hidden');

    fireEvent.click(screen.getByRole('button', { name: /^Thinking/ }));
    expect(screen.getByRole('dialog', { name: 'Reasoning Effort' })).toBeVisible();
    expect(outside.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('normalizes numeric thinking budgets onto the same scale with exact input and auto', () => {
    const onChange = jest.fn();
    render(
      <ReasoningControl
        index={0}
        setting={budgetSetting}
        value={{ key: 'thinkingBudget', value: 4096 }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Thinking/ }));
    const slider = screen.getByRole('slider', { name: 'Thinking Budget' });
    expect(slider).toHaveAttribute('aria-valuemin', '128');
    expect(slider).toHaveAttribute('aria-valuemax', '32768');
    expect(slider).toHaveAttribute('aria-valuenow', '4096');

    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith({ key: 'thinkingBudget', value: 4224 });

    const input = screen.getByRole('spinbutton', { name: 'Thinking Budget' });
    fireEvent.change(input, { target: { value: '8192' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({ key: 'thinkingBudget', value: 8192 });

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(onChange).toHaveBeenLastCalledWith({ key: 'thinkingBudget', value: -1 });
  });

  it('clamps an invalid positive budget to the model-specific floor', () => {
    const onChange = jest.fn();
    render(
      <ReasoningControl
        index={0}
        setting={budgetSetting}
        value={{ key: 'thinkingBudget', value: -1 }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Thinking/ }));
    const input = screen.getByRole('spinbutton', { name: 'Thinking Budget' });
    fireEvent.change(input, { target: { value: '16' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenLastCalledWith({ key: 'thinkingBudget', value: 128 });
  });

  it.each([undefined, -1, 4096])('does not stage an unchanged numeric budget (%s)', (value) => {
    const onChange = jest.fn();
    render(
      <ReasoningControl
        index={0}
        setting={budgetSetting}
        value={value == null ? undefined : { key: 'thinkingBudget', value }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Thinking/ }));
    const input = screen.getByRole('spinbutton', { name: 'Thinking Budget' });
    fireEvent.focus(input);
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([-1, 0])(
    'restores the supported minimum (%s) when the numeric field is cleared',
    (min) => {
      const onChange = jest.fn();
      render(
        <ReasoningControl
          index={0}
          setting={{ ...budgetSetting, range: { ...budgetRange, min } }}
          value={{ key: 'thinkingBudget', value: 4096 }}
          onChange={onChange}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /^Thinking/ }));
      const input = screen.getByRole('spinbutton', { name: 'Thinking Budget' });
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.blur(input);

      expect(onChange).toHaveBeenLastCalledWith({ key: 'thinkingBudget', value: min });
    },
  );
});
