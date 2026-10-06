/**
 * @jest-environment jsdom
 */
import type { TPrompt } from 'librechat-data-provider';
import {
  isRestrictedInstructionsPrompt,
  buildPromptVersionOptions,
  getInstructionsPromptErrorCode,
  getHttpStatus,
} from '../instructionsPromptUtils';

const localize = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

const axiosError = (status: number, code?: string) => ({
  isAxiosError: true,
  response: { status, data: code ? { code } : {} },
});

describe('isRestrictedInstructionsPrompt', () => {
  it('returns false for null and undefined', () => {
    expect(isRestrictedInstructionsPrompt(null)).toBe(false);
    expect(isRestrictedInstructionsPrompt(undefined)).toBe(false);
  });

  it('returns false for a real link', () => {
    expect(
      isRestrictedInstructionsPrompt({
        source: 'native',
        groupId: 'g1',
        selection: { type: 'production' },
      }),
    ).toBe(false);
  });

  it('returns true for the restricted stub', () => {
    expect(isRestrictedInstructionsPrompt({ source: 'native', restricted: true })).toBe(true);
  });
});

describe('buildPromptVersionOptions', () => {
  const prompts: TPrompt[] = [
    {
      _id: 'p3',
      groupId: 'g1',
      author: 'a',
      prompt: 'newest',
      type: 'text',
      createdAt: '',
      updatedAt: '',
    },
    {
      _id: 'p2',
      groupId: 'g1',
      author: 'a',
      prompt: 'middle',
      type: 'text',
      createdAt: '',
      updatedAt: '',
    },
    {
      _id: 'p1',
      groupId: 'g1',
      author: 'a',
      prompt: 'oldest',
      type: 'text',
      createdAt: '',
      updatedAt: '',
    },
  ];

  it('lists Production first, then versions newest to oldest', () => {
    const options = buildPromptVersionOptions(prompts, undefined, localize);

    expect(options.map((option) => option.value)).toEqual(['production', 'p3', 'p2', 'p1']);
    expect(options[0].selection).toEqual({ type: 'production' });
    expect(options[1]).toEqual({
      value: 'p3',
      label: 'com_ui_version_var:{"0":"3"}',
      selection: { type: 'exact', promptId: 'p3' },
    });
    expect(options[3]).toEqual({
      value: 'p1',
      label: 'com_ui_version_var:{"0":"1"}',
      selection: { type: 'exact', promptId: 'p1' },
    });
  });

  it('labels Production with its display number when the revision is known', () => {
    const options = buildPromptVersionOptions(prompts, 'p2', localize);

    expect(options[0].label).toBe('com_agents_instructions_prompt_production_version:{"0":"2"}');
  });

  it('falls back to a plain Production label when the revision is unknown', () => {
    const options = buildPromptVersionOptions(prompts, 'not-in-group', localize);

    expect(options[0].label).toBe('com_ui_production');
  });

  it('falls back to a plain Production label when no production id is given', () => {
    const options = buildPromptVersionOptions(prompts, null, localize);

    expect(options[0].label).toBe('com_ui_production');
  });
});

describe('getHttpStatus', () => {
  it('reads the status off an axios-shaped error', () => {
    expect(getHttpStatus(axiosError(403))).toBe(403);
  });

  it('returns undefined for a non-HTTP error', () => {
    expect(getHttpStatus(new Error('network down'))).toBeUndefined();
  });
});

describe('getInstructionsPromptErrorCode', () => {
  it('reads a known error code off the response body', () => {
    expect(getInstructionsPromptErrorCode(axiosError(403, 'instructions_prompt_forbidden'))).toBe(
      'instructions_prompt_forbidden',
    );
    expect(getInstructionsPromptErrorCode(axiosError(400, 'instructions_prompt_unavailable'))).toBe(
      'instructions_prompt_unavailable',
    );
    expect(
      getInstructionsPromptErrorCode(axiosError(500, 'instructions_prompt_validation_failed')),
    ).toBe('instructions_prompt_validation_failed');
  });

  it('returns undefined for an unrecognized code', () => {
    expect(getInstructionsPromptErrorCode(axiosError(400, 'some_other_code'))).toBeUndefined();
  });

  it('returns undefined for a non-HTTP error', () => {
    expect(getInstructionsPromptErrorCode(new Error('offline'))).toBeUndefined();
  });
});
