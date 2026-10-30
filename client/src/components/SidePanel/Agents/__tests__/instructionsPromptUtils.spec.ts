/**
 * @jest-environment jsdom
 */
import type { TPromptRevisionChoicesResponse } from 'librechat-data-provider';
import {
  isRestrictedInstructionsPrompt,
  buildPromptVersionOptions,
  getInstructionsPromptErrorCode,
  getRevisionsLoadErrorKey,
  selectionValue,
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

describe('selectionValue', () => {
  it('returns "production" for an undefined selection', () => {
    expect(selectionValue(undefined, undefined)).toBe('production');
  });

  it('returns "production" for a production selection', () => {
    expect(selectionValue('native', { type: 'production' })).toBe('production');
  });

  it('returns the prompt id for a native exact selection', () => {
    expect(selectionValue('native', { type: 'exact', promptId: 'p1' })).toBe('p1');
  });

  it('returns "v<version>" for a Langfuse exact selection', () => {
    expect(selectionValue('langfuse', { type: 'exact', version: 3 })).toBe('v3');
  });
});

describe('buildPromptVersionOptions', () => {
  const nativeData = (
    revisions: TPromptRevisionChoicesResponse['revisions'],
  ): TPromptRevisionChoicesResponse => ({
    source: 'native',
    groupId: 'g1',
    revisions,
  });

  const langfuseData = (
    revisions: TPromptRevisionChoicesResponse['revisions'],
  ): TPromptRevisionChoicesResponse => ({
    source: 'langfuse',
    groupId: 'g1',
    revisions,
  });

  describe('native', () => {
    const revisions: TPromptRevisionChoicesResponse['revisions'] = [
      { source: 'native', promptId: 'p3', version: 3, isProduction: false },
      { source: 'native', promptId: 'p2', version: 2, isProduction: true },
      { source: 'native', promptId: 'p1', version: 1, isProduction: false },
    ];

    it('lists Production first, then versions newest to oldest', () => {
      const options = buildPromptVersionOptions(nativeData(revisions), undefined, localize);

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

    it('labels Production with the revision marked `isProduction`', () => {
      const options = buildPromptVersionOptions(nativeData(revisions), undefined, localize);

      expect(options[0].label).toBe('com_agents_instructions_prompt_production_version:{"0":"2"}');
    });

    it('falls back to a plain Production label when no revision is marked `isProduction`', () => {
      const noProduction = revisions.map((revision) => ({ ...revision, isProduction: false }));
      const options = buildPromptVersionOptions(nativeData(noProduction), undefined, localize);

      expect(options[0].label).toBe('com_ui_production');
    });

    it('appends the saved exact selection, labelled as missing, when it matches no revision', () => {
      const options = buildPromptVersionOptions(
        nativeData(revisions),
        {
          type: 'exact',
          promptId: 'deleted',
        },
        localize,
      );

      expect(options[options.length - 1]).toEqual({
        value: 'deleted',
        label: 'com_agents_instructions_prompt_version_missing',
        selection: { type: 'exact', promptId: 'deleted' },
      });
    });

    it('does not append anything extra when the saved selection matches a listed revision', () => {
      const options = buildPromptVersionOptions(
        nativeData(revisions),
        {
          type: 'exact',
          promptId: 'p1',
        },
        localize,
      );

      expect(options).toHaveLength(4);
    });

    it('does not append anything extra for a saved production selection', () => {
      const options = buildPromptVersionOptions(
        nativeData(revisions),
        {
          type: 'production',
        },
        localize,
      );

      expect(options).toHaveLength(4);
    });
  });

  describe('langfuse', () => {
    const revisions: TPromptRevisionChoicesResponse['revisions'] = [
      { source: 'langfuse', version: 3 },
      { source: 'langfuse', version: 2 },
      { source: 'langfuse', version: 1 },
    ];

    it('lists Production first with the plain label, then versions newest to oldest', () => {
      const options = buildPromptVersionOptions(langfuseData(revisions), undefined, localize);

      expect(options.map((option) => option.value)).toEqual(['production', 'v3', 'v2', 'v1']);
      expect(options[0].label).toBe('com_ui_production');
      expect(options[0].selection).toEqual({ type: 'production' });
      expect(options[1]).toEqual({
        value: 'v3',
        label: 'com_ui_version_var:{"0":"3"}',
        selection: { type: 'exact', version: 3 },
      });
    });

    it('appends the saved pinned version, labelled as missing with the version number, when it matches no revision', () => {
      const options = buildPromptVersionOptions(
        langfuseData(revisions),
        {
          type: 'exact',
          version: 9,
        },
        localize,
      );

      expect(options[options.length - 1]).toEqual({
        value: 'v9',
        label: 'com_agents_instructions_prompt_langfuse_version_missing:{"0":"9"}',
        selection: { type: 'exact', version: 9 },
      });
    });

    it('does not append anything extra when the saved version matches a listed revision', () => {
      const options = buildPromptVersionOptions(
        langfuseData(revisions),
        {
          type: 'exact',
          version: 2,
        },
        localize,
      );

      expect(options).toHaveLength(4);
    });
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

describe('getRevisionsLoadErrorKey', () => {
  it('maps a 403 to the forbidden copy', () => {
    expect(getRevisionsLoadErrorKey(axiosError(403))).toBe(
      'com_agents_instructions_prompt_forbidden',
    );
  });

  it('maps a 404 "not_available" to the source-unavailable copy', () => {
    expect(getRevisionsLoadErrorKey(axiosError(404, 'not_available'))).toBe(
      'com_agents_instructions_prompt_source_unavailable',
    );
  });

  it('maps a plain 404 "not_found" (missing group) to the generic load-error copy', () => {
    expect(getRevisionsLoadErrorKey(axiosError(404, 'not_found'))).toBe(
      'com_agents_instructions_prompt_load_error',
    );
  });

  it('maps a 409 "not_configured" to the source-unavailable copy', () => {
    expect(getRevisionsLoadErrorKey(axiosError(409, 'not_configured'))).toBe(
      'com_agents_instructions_prompt_source_unavailable',
    );
  });

  it('maps a 409 "source_changed" to the source-unavailable copy', () => {
    expect(getRevisionsLoadErrorKey(axiosError(409, 'source_changed'))).toBe(
      'com_agents_instructions_prompt_source_unavailable',
    );
  });

  it('maps a 422 "unsupported_type" to the source-unavailable copy', () => {
    expect(getRevisionsLoadErrorKey(axiosError(422, 'unsupported_type'))).toBe(
      'com_agents_instructions_prompt_source_unavailable',
    );
  });

  it('falls back to the generic load-error copy for anything else', () => {
    expect(getRevisionsLoadErrorKey(axiosError(500))).toBe(
      'com_agents_instructions_prompt_load_error',
    );
    expect(getRevisionsLoadErrorKey(new Error('network down'))).toBe(
      'com_agents_instructions_prompt_load_error',
    );
  });
});
