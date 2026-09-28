import { ErrorTypes } from 'librechat-data-provider';
import {
  getCodeWorkspaceSelectionErrorDetails,
  shouldPersistCodeWorkspaceInitializationError,
} from './errors';

describe('getCodeWorkspaceSelectionErrorDetails', () => {
  it.each(['required', 'invalid', 'worker_unavailable', 'unsupported', 'missing'] as const)(
    'preserves the allowlisted workspace reason %s',
    (reason) => {
      expect(
        getCodeWorkspaceSelectionErrorDetails({
          code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
          reason,
        }),
      ).toEqual({ reason });
    },
  );

  it.each([
    { code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE, reason: 'future_reason' },
    { code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE },
    { code: 'ANOTHER_ERROR', reason: 'required' },
    null,
  ])('omits unrecognized or unrelated error details', (error) => {
    expect(getCodeWorkspaceSelectionErrorDetails(error)).toEqual({});
  });
});

describe('shouldPersistCodeWorkspaceInitializationError', () => {
  it('keeps a rejected first-turn decision retryable', () => {
    expect(
      shouldPersistCodeWorkspaceInitializationError({
        streamStarted: true,
        isNewConversation: true,
        failureCode: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
        hasValidatedDecision: false,
      }),
    ).toBe(false);
  });

  it.each([
    { isNewConversation: false, hasValidatedDecision: false },
    { isNewConversation: true, hasValidatedDecision: true },
  ])('persists an initialized workspace failure for %o', (state) => {
    expect(
      shouldPersistCodeWorkspaceInitializationError({
        streamStarted: true,
        failureCode: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
        ...state,
      }),
    ).toBe(true);
  });

  it('does not persist any initialization error before the stream starts', () => {
    expect(
      shouldPersistCodeWorkspaceInitializationError({
        streamStarted: false,
        isNewConversation: false,
        failureCode: 'MODEL_UNAVAILABLE',
        hasValidatedDecision: true,
      }),
    ).toBe(false);
  });
});
