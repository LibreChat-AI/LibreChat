import { useResetRecoilState, useSetRecoilState } from 'recoil';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MutationKeys, QueryKeys, dataService, request } from 'librechat-data-provider';
import type { UseMutationOptions, UseMutationResult } from '@tanstack/react-query';
import type * as t from 'librechat-data-provider';
import useClearStates from '~/hooks/Config/useClearStates';
import { clearAllConversationStorage } from '~/utils';
import store from '~/store';

/* login/logout */
export const useLogoutUserMutation = (
  options?: t.LogoutOptions,
): UseMutationResult<t.TLogoutResponse, unknown, undefined, unknown> => {
  const queryClient = useQueryClient();
  const clearStates = useClearStates();
  const resetDefaultPreset = useResetRecoilState(store.defaultPreset);
  const setQueriesEnabled = useSetRecoilState<boolean>(store.queriesEnabled);

  return useMutation([MutationKeys.logoutUser], {
    mutationFn: () => dataService.logout(),
    ...(options || {}),
    onSuccess: (...args) => {
      setQueriesEnabled(false);
      resetDefaultPreset();
      clearStates();
      queryClient.removeQueries();
      options?.onSuccess?.(...args);
    },
  });
};

export const useLoginUserMutation = (
  options?: t.MutationOptions<t.TLoginResponse, t.TLoginUser, unknown, unknown>,
): UseMutationResult<t.TLoginResponse, unknown, t.TLoginUser, unknown> => {
  const queryClient = useQueryClient();
  const clearStates = useClearStates();
  const resetDefaultPreset = useResetRecoilState(store.defaultPreset);
  const setQueriesEnabled = useSetRecoilState<boolean>(store.queriesEnabled);
  return useMutation([MutationKeys.loginUser], {
    mutationFn: (payload: t.TLoginUser) => dataService.login(payload),
    ...(options || {}),
    onMutate: (vars) => {
      setQueriesEnabled(false);
      resetDefaultPreset();
      clearStates();
      queryClient.removeQueries();
      options?.onMutate?.(vars);
    },
    // Queries re-enabled in setUserContext (AuthContext) after setTokenHeader runs
    onSuccess: (...args) => {
      options?.onSuccess?.(...args);
    },
    onError: (...args) => {
      setQueriesEnabled(true);
      options?.onError?.(...args);
    },
  });
};

export const useRefreshTokenMutation = (
  options?: t.MutationOptions<t.TRefreshTokenResponse | undefined, undefined, unknown, unknown>,
): UseMutationResult<t.TRefreshTokenResponse | undefined, unknown, undefined, unknown> => {
  const queryClient = useQueryClient();
  return useMutation([MutationKeys.refreshToken], {
    mutationFn: () => request.refreshToken(),
    ...(options || {}),
    onMutate: (vars) => {
      queryClient.removeQueries();
      options?.onMutate?.(vars);
    },
  });
};

/* User */
export const useDeleteUserMutation = (
  options?: t.MutationOptions<unknown, t.TDeleteUserRequest | undefined>,
): UseMutationResult<unknown, unknown, t.TDeleteUserRequest | undefined, unknown> => {
  const queryClient = useQueryClient();
  const clearStates = useClearStates();
  const resetDefaultPreset = useResetRecoilState(store.defaultPreset);

  return useMutation([MutationKeys.deleteUser], {
    mutationFn: (payload?: t.TDeleteUserRequest) => dataService.deleteUser(payload),
    ...(options || {}),
    onSuccess: (...args) => {
      resetDefaultPreset();
      clearStates();
      clearAllConversationStorage();
      queryClient.removeQueries();
      options?.onSuccess?.(...args);
    },
  });
};

export const useUpdateUserPreferencesMutation = (
  options?: UseMutationOptions<
    t.TUpdateUserPreferencesResponse,
    Error,
    t.TUpdateUserPreferencesRequest
  >,
): UseMutationResult<
  t.TUpdateUserPreferencesResponse,
  Error,
  t.TUpdateUserPreferencesRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation<t.TUpdateUserPreferencesResponse, Error, t.TUpdateUserPreferencesRequest>(
    [MutationKeys.updateUserPreferences],
    (preferences: t.TUpdateUserPreferencesRequest) =>
      dataService.updateUserPreferences(preferences),
    {
      ...options,
      onSuccess: (data, ...args) => {
        queryClient.setQueryData<t.TUser>([QueryKeys.user], (user) =>
          user
            ? {
                ...user,
                personalization: {
                  ...user.personalization,
                  ...data.preferences,
                },
              }
            : user,
        );
        options?.onSuccess?.(data, ...args);
      },
    },
  );
};

export const useRequestEmailChangeMutation = (
  options?: t.MutationOptions<t.TEmailChangeResponse, t.TRequestEmailChange>,
): UseMutationResult<t.TEmailChangeResponse, unknown, t.TRequestEmailChange, unknown> => {
  return useMutation({
    mutationFn: (payload: t.TRequestEmailChange) => dataService.requestEmailChange(payload),
    ...(options ?? {}),
  });
};

export const useConfirmEmailChangeMutation = (
  options?: t.MutationOptions<t.TEmailChangeResponse, t.TConfirmEmailChange>,
): UseMutationResult<t.TEmailChangeResponse, unknown, t.TConfirmEmailChange, unknown> => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: t.TConfirmEmailChange) => dataService.confirmEmailChange(payload),
    ...(options ?? {}),
    onSuccess: (...args) => {
      queryClient.invalidateQueries([QueryKeys.user]);
      options?.onSuccess?.(...args);
    },
  });
};

export const useEnableTwoFactorMutation = (): UseMutationResult<
  t.TEnable2FAResponse,
  unknown,
  t.TEnable2FARequest | undefined,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation((payload?: t.TEnable2FARequest) => dataService.enableTwoFactor(payload), {
    onSuccess: (data) => {
      queryClient.setQueryData([QueryKeys.user, '2fa'], data);
    },
  });
};

export const useVerifyTwoFactorMutation = (): UseMutationResult<
  t.TVerify2FAResponse,
  unknown,
  t.TVerify2FARequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation((payload: t.TVerify2FARequest) => dataService.verifyTwoFactor(payload), {
    onSuccess: (data) => {
      queryClient.setQueryData([QueryKeys.user, '2fa'], data);
    },
  });
};

export const useConfirmTwoFactorMutation = (): UseMutationResult<
  t.TVerify2FAResponse,
  unknown,
  t.TVerify2FARequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation((payload: t.TVerify2FARequest) => dataService.confirmTwoFactor(payload), {
    onSuccess: (data) => {
      queryClient.setQueryData([QueryKeys.user, '2fa'], data);
    },
  });
};

export const useDisableTwoFactorMutation = (): UseMutationResult<
  t.TDisable2FAResponse,
  unknown,
  t.TDisable2FARequest | undefined,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation((payload?: t.TDisable2FARequest) => dataService.disableTwoFactor(payload), {
    onSuccess: () => {
      queryClient.setQueryData([QueryKeys.user, '2fa'], null);
    },
  });
};

export const useRegenerateBackupCodesMutation = (): UseMutationResult<
  t.TRegenerateBackupCodesResponse,
  unknown,
  t.TRegenerateBackupCodesRequest | undefined,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation(
    (payload?: t.TRegenerateBackupCodesRequest) => dataService.regenerateBackupCodes(payload),
    {
      onSuccess: (data) => {
        queryClient.setQueryData([QueryKeys.user, '2fa', 'backup'], data);
      },
    },
  );
};

export const useVerifyTwoFactorTempMutation = (
  options?: t.MutationOptions<t.TVerify2FATempResponse, t.TVerify2FATempRequest, unknown, unknown>,
): UseMutationResult<t.TVerify2FATempResponse, unknown, t.TVerify2FATempRequest, unknown> => {
  const queryClient = useQueryClient();
  return useMutation(
    (payload: t.TVerify2FATempRequest) => dataService.verifyTwoFactorTemp(payload),
    {
      ...(options || {}),
      onSuccess: (data, ...args) => {
        queryClient.setQueryData([QueryKeys.user, '2fa'], data);
        options?.onSuccess?.(data, ...args);
      },
    },
  );
};

/* passkeys */
export const useRegisterPasskeyMutation = (): UseMutationResult<
  t.TPasskeyResponse,
  unknown,
  t.TVerifyPasskeyRegistrationRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.registerPasskey],
    (payload: t.TVerifyPasskeyRegistrationRequest) =>
      dataService.verifyPasskeyRegistration(payload),
    {
      onSuccess: () => {
        queryClient.invalidateQueries([QueryKeys.passkeys]);
      },
    },
  );
};

export const useRenamePasskeyMutation = (): UseMutationResult<
  t.TPasskeyResponse,
  unknown,
  t.TRenamePasskeyRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.renamePasskey],
    (payload: t.TRenamePasskeyRequest) => dataService.renamePasskey(payload),
    {
      onSuccess: () => {
        queryClient.invalidateQueries([QueryKeys.passkeys]);
      },
    },
  );
};

export const useDeletePasskeyMutation = (): UseMutationResult<
  { message: string },
  unknown,
  t.TDeletePasskeyRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.deletePasskey],
    (payload: t.TDeletePasskeyRequest) => dataService.deletePasskey(payload),
    {
      onSuccess: () => {
        queryClient.invalidateQueries([QueryKeys.passkeys]);
      },
    },
  );
};
