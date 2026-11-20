/**
 * @jest-environment jsdom
 */
import React from 'react';
import { ReasoningEffort } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SettingDefinition, TConversation } from 'librechat-data-provider';
import Effort, { effortRank, leanFor, resolveEffortLabel } from '../Effort';
import { initEnglish } from '../../../../__fixtures__/i18n';

/**
 * The thinking-level track: a radiogroup of named stops that arrow keys move along, with the
 * separate mode ranked below every level and the held thumb's lean bounded.
 */

const setting = {
  key: 'reasoning_effort',
  type: 'enum',
  default: 'low',
  options: ['auto', 'low', 'medium', 'high'],
} as SettingDefinition;

const conversation = { conversationId: 'c-1' } as TConversation;

beforeAll(async () => {
  await initEnglish();
  window.matchMedia = jest.fn(() => ({
    matches: true,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
});

describe('Effort', () => {
  it('ranks levels in order and the separate mode below them', () => {
    expect(effortRank(setting, 'auto')).toBe(-1);
    expect(effortRank(setting, 'low')).toBe(0);
    expect(effortRank(setting, 'high')).toBe(2);
  });

  it('leans toward the pointer with growing resistance, never past its limit', () => {
    expect(leanFor(0)).toBe(0);
    expect(leanFor(5)).toBeGreaterThan(0);
    expect(leanFor(-5)).toBeLessThan(0);
    expect(leanFor(10_000)).toBeLessThan(10);
  });

  it('names a level through its mapped translation, else the capitalized value', () => {
    const mapped = { ...setting, enumMappings: { medium: 'com_ui_medium' } } as SettingDefinition;
    expect(resolveEffortLabel(mapped, 'medium', (key) => `t:${key}`)).toBe('t:com_ui_medium');
    expect(resolveEffortLabel(setting, 'medium', (key) => key)).toBe('Medium');
    expect(resolveEffortLabel(setting, 'auto', (key) => `t:${key}`)).toBe('t:com_ui_auto');
  });

  it('is a radiogroup whose arrow keys move the selection to the next stop', () => {
    const onChange = jest.fn();
    render(
      <Effort
        setting={setting}
        conversation={conversation}
        value={{ key: 'reasoning_effort', value: ReasoningEffort.low }}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole('radiogroup', { name: 'Thinking' })).toBeInTheDocument();
    const checked = screen.getByRole('radio', { checked: true });
    expect(checked).toHaveAccessibleName('Low');
    fireEvent.keyDown(checked, { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith({ key: 'reasoning_effort', value: 'medium' });
  });
});
