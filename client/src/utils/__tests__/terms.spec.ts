import { QueryKeys, TERMS_NOT_ACCEPTED_CODE } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import { hasTermsRefusal, reopenTermsOnRefusal } from '../terms';

describe('terms refusal helpers', () => {
  it.each([
    [{ code: TERMS_NOT_ACCEPTED_CODE }, true],
    [{ error: { code: TERMS_NOT_ACCEPTED_CODE } }, true],
    [{ code: 'other' }, false],
    [null, false],
    ['terms_not_accepted', false],
  ])('detects a refusal in %j', (data, expected) => {
    expect(hasTermsRefusal(data)).toBe(expected);
  });

  it('refetches the startup config and terms status only for a refusal', () => {
    const invalidateQueries = jest.fn();
    const queryClient = { invalidateQueries } as unknown as QueryClient;

    expect(reopenTermsOnRefusal(queryClient, { code: 'other' })).toBe(false);
    expect(invalidateQueries).not.toHaveBeenCalled();

    expect(reopenTermsOnRefusal(queryClient, { code: TERMS_NOT_ACCEPTED_CODE })).toBe(true);
    expect(invalidateQueries).toHaveBeenCalledWith([QueryKeys.startupConfig]);
    expect(invalidateQueries).toHaveBeenCalledWith([QueryKeys.userTerms]);
  });
});
