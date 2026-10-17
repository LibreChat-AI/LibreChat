import { getPromptErrorMessage } from '../promptErrors';

/** An axios-style rejection the way the real backend sends one: an outer HTTP status plus a
 *  `{ code, status? }` body. */
function axiosError(outerStatus: number, data: { code?: string; status?: number } = {}) {
  return { isAxiosError: true, response: { status: outerStatus, data } };
}

const localize = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${Object.values(options).join(',')}` : key;

describe('getPromptErrorMessage', () => {
  it('returns the forbidden copy for a 403, ahead of any body code', () => {
    const error = axiosError(403, { message: 'Forbidden' } as { code?: string });

    expect(getPromptErrorMessage(error, localize)).toBe('com_ui_langfuse_prompt_error_forbidden');
  });

  it('returns the forbidden copy for a 403 even when the body carries an unrelated code', () => {
    const error = axiosError(403, { code: 'unauthorized' });

    expect(getPromptErrorMessage(error, localize)).toBe('com_ui_langfuse_prompt_error_forbidden');
  });

  it('maps the internal code to its localized copy', () => {
    const error = axiosError(500, { code: 'internal' });

    expect(getPromptErrorMessage(error, localize)).toBe('com_ui_langfuse_prompt_error_internal');
  });

  it('maps a known code to its localized copy', () => {
    const error = axiosError(409, { code: 'already_running' });

    expect(getPromptErrorMessage(error, localize)).toBe(
      'com_ui_langfuse_prompt_error_already_running',
    );
  });

  it('includes the Langfuse HTTP status for an upstream failure', () => {
    const error = axiosError(502, { code: 'upstream', status: 400 });

    expect(getPromptErrorMessage(error, localize)).toBe(
      'com_ui_langfuse_prompt_error_upstream_status:400',
    );
  });

  it('falls back to the generic copy for an unmapped code', () => {
    const error = axiosError(500, { code: 'something_unexpected' });

    expect(getPromptErrorMessage(error, localize)).toBe('com_ui_langfuse_prompt_error_fallback');
  });

  it('falls back to the generic copy for a non-axios error', () => {
    expect(getPromptErrorMessage(new Error('boom'), localize)).toBe(
      'com_ui_langfuse_prompt_error_fallback',
    );
  });
});
