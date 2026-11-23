import type { LocalizeFunction } from '~/common';
import { getPromptErrorMessage, getPromptResolveErrorMessage } from '../promptErrors';

/** The mock interpolates `{{0}}`-style i18next options by appending their values, so a test
 *  can assert that a localized line actually carried the HTTP status it was given. */
const localize: LocalizeFunction = (key, options) =>
  options ? `${key}:${Object.values(options).join(',')}` : key;

/** An axios-style rejection the way the real backend sends one: an outer HTTP status plus a
 *  JSON body. Both mappers read `error.response.data`. */
function axiosError(outerStatus: number, data: Record<string, unknown>) {
  return { isAxiosError: true, response: { status: outerStatus, data } };
}

describe('getPromptResolveErrorMessage', () => {
  it('maps a content-filter block, which has no code, before checking status or code', () => {
    const error = axiosError(400, { error: 'content_filter_block' });
    expect(getPromptResolveErrorMessage(error, localize)).toBe(
      'com_ui_prompt_resolve_error_blocked',
    );
  });

  it('maps a 403 (ACL middleware body, no code) to the forbidden message', () => {
    const error = axiosError(403, { error: 'Forbidden' });
    expect(getPromptResolveErrorMessage(error, localize)).toBe(
      'com_ui_prompt_resolve_error_forbidden',
    );
  });

  it('maps a 403 to the forbidden message even when the body carries an unrelated code', () => {
    const error = axiosError(403, { code: 'not_found' });
    expect(getPromptResolveErrorMessage(error, localize)).toBe(
      'com_ui_prompt_resolve_error_forbidden',
    );
  });

  it('maps a 429 (no code in the body) to the rate-limited message', () => {
    const error = axiosError(429, { message: 'Too many requests' });
    expect(getPromptResolveErrorMessage(error, localize)).toBe(
      'com_ui_prompt_resolve_error_rate_limited',
    );
  });

  it('maps not_found to its own resolve-specific key, not the dialog mapper key', () => {
    const error = axiosError(404, { code: 'not_found' });
    expect(getPromptResolveErrorMessage(error, localize)).toBe(
      'com_ui_prompt_resolve_error_not_found',
    );
  });

  it('maps not_available to the resolve-specific "turned off" key', () => {
    const error = axiosError(404, { code: 'not_available' });
    expect(getPromptResolveErrorMessage(error, localize)).toBe(
      'com_ui_prompt_resolve_error_not_available',
    );
  });

  it('maps source_changed to the resolve-specific key', () => {
    const error = axiosError(409, { code: 'source_changed' });
    expect(getPromptResolveErrorMessage(error, localize)).toBe(
      'com_ui_prompt_resolve_error_source_changed',
    );
  });

  it.each([
    ['invalid_request', 'com_ui_langfuse_prompt_error_invalid_request'],
    ['unsupported_type', 'com_ui_langfuse_prompt_error_unsupported_type'],
    ['not_configured', 'com_ui_langfuse_prompt_error_not_configured'],
    ['unauthorized', 'com_ui_langfuse_prompt_error_unauthorized'],
    ['timeout', 'com_ui_langfuse_prompt_error_timeout'],
    ['invalid_response', 'com_ui_langfuse_prompt_error_invalid_response'],
  ])('reuses the dialog mapper key for the shared transport code %s', (code, key) => {
    const error = axiosError(409, { code });
    expect(getPromptResolveErrorMessage(error, localize)).toBe(key);
  });

  it('maps upstream with a status to the status-carrying key', () => {
    const error = axiosError(502, { code: 'upstream', status: 503 });
    expect(getPromptResolveErrorMessage(error, localize)).toBe(
      'com_ui_langfuse_prompt_error_upstream_status:503',
    );
  });

  it('maps upstream with no status to the plain upstream key', () => {
    const error = axiosError(502, { code: 'upstream' });
    expect(getPromptResolveErrorMessage(error, localize)).toBe(
      'com_ui_langfuse_prompt_error_upstream',
    );
  });

  it('falls back for an unexpected 500 with no code', () => {
    const error = axiosError(500, { message: 'Error resolving prompt' });
    expect(getPromptResolveErrorMessage(error, localize)).toBe(
      'com_ui_langfuse_prompt_error_fallback',
    );
  });

  it('falls back for a non-axios error', () => {
    expect(getPromptResolveErrorMessage(new Error('network down'), localize)).toBe(
      'com_ui_langfuse_prompt_error_fallback',
    );
  });
});

describe('getPromptErrorMessage', () => {
  it('keeps its own not_found copy, distinct from the resolve mapper key', () => {
    const error = axiosError(404, { code: 'not_found' });
    expect(getPromptErrorMessage(error, localize)).toBe('com_ui_langfuse_prompt_error_not_found');
  });

  it('returns the forbidden copy for a 403, ahead of any body code', () => {
    const error = axiosError(403, { message: 'Forbidden' });
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

  it('maps upstream with a status to the status-carrying key', () => {
    const error = axiosError(502, { code: 'upstream', status: 503 });
    expect(getPromptErrorMessage(error, localize)).toBe(
      'com_ui_langfuse_prompt_error_upstream_status:503',
    );
  });

  it('falls back for an unmapped code', () => {
    const error = axiosError(500, { code: 'something_new' });
    expect(getPromptErrorMessage(error, localize)).toBe('com_ui_langfuse_prompt_error_fallback');
  });

  it('falls back to the generic copy for a non-axios error', () => {
    expect(getPromptErrorMessage(new Error('boom'), localize)).toBe(
      'com_ui_langfuse_prompt_error_fallback',
    );
  });
});
