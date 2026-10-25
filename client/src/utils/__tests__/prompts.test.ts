import { getPromptMutationErrorKey } from '../prompts';

const axiosError = (status: number, code?: string) => ({
  isAxiosError: true,
  response: { status, data: code ? { code } : {} },
});

describe('getPromptMutationErrorKey', () => {
  it('maps a read_only response code to the externally-managed message', () => {
    expect(
      getPromptMutationErrorKey(axiosError(403, 'read_only'), 'com_ui_prompt_update_error'),
    ).toBe('com_ui_prompt_read_only_error');
  });

  it('falls back to the caller message when the response carries a different code', () => {
    expect(
      getPromptMutationErrorKey(axiosError(400, 'invalid_request'), 'com_ui_prompt_update_error'),
    ).toBe('com_ui_prompt_update_error');
  });

  it('falls back to the caller message when the response carries no code', () => {
    expect(getPromptMutationErrorKey(axiosError(500), 'com_ui_prompt_delete_error')).toBe(
      'com_ui_prompt_delete_error',
    );
  });

  it('falls back to the caller message for a non-axios error', () => {
    expect(getPromptMutationErrorKey(new Error('network down'), 'com_ui_prompt_update_error')).toBe(
      'com_ui_prompt_update_error',
    );
  });
});
