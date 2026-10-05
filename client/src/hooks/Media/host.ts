import { useCallback, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { getConfigDefaults, Permissions, PermissionTypes } from 'librechat-data-provider';
import type { ComposerProps } from '@librechat/client';
import type { MediaHost } from '~/components/Media/host';
import useComposerBindings from '~/hooks/Input/useComposerBindings';
import { useMediaSessionGuard } from '~/components/Media/session';
import { resolveComposerKeyDown } from '~/utils/shortcuts';
import { useGetUserBalance } from '~/data-provider';
import { useMediaAccess } from './useMediaAccess';
import { useHasAccess } from '~/hooks';
import store from '~/store';

const defaultInterface = getConfigDefaults().interface;

/** Shell preferences and identity cross the feature boundary through this host adapter. */
export function useMediaShellHost(actions: Pick<MediaHost, 'openThread' | 'useInChat'>) {
  const { user, scope, isAuthenticated, isAuthReady, startupQuery, startup, canUse, canCreate } =
    useMediaAccess();
  const balance = useGetUserBalance({
    enabled: isAuthenticated && startup?.balance?.enabled === true,
  });
  const { refetch: refetchBalance } = balance;
  const refreshBalance = useCallback(() => {
    void refetchBalance();
  }, [refetchBalance]);
  const canTemporary = useHasAccess({
    permissionType: PermissionTypes.TEMPORARY_CHAT,
    permission: Permissions.USE,
  });
  const canCompare = useHasAccess({
    permissionType: PermissionTypes.MULTI_CONVO,
    permission: Permissions.USE,
  });
  const presets = (startup?.interface?.presets ?? defaultInterface.presets) !== false;
  const enterToSend = useRecoilValue(store.enterToSend);
  const { shortcutsEnabled, submitOverride, yieldedChords } = useComposerBindings();
  const userId = user?.id;
  const isCurrentSession = useMediaSessionGuard(scope, isAuthenticated);
  const resolveKeyVerdict = useCallback<NonNullable<ComposerProps['resolveKeyVerdict']>>(
    (event, isComposing) => {
      const action = resolveComposerKeyDown(event, {
        isComposing,
        isSubmitting: false,
        allowSubmitWhileGenerating: false,
        hasDuringRunModifier: false,
        shortcutsEnabled,
        enterToSend,
        submitOverride,
        yieldedChords,
      });
      return action === 'submit' || action === 'newline' || action === 'block' ? action : 'none';
    },
    [shortcutsEnabled, enterToSend, submitOverride, yieldedChords],
  );
  const media = startup?.media;
  const host = useMemo<MediaHost | undefined>(
    () =>
      media && scope && isAuthenticated && canUse
        ? {
            scope,
            userId,
            canCreate: canCreate && media.canCreate,
            balance: balance.data,
            refreshBalance,
            pollIntervalMs: media.clientPollIntervalMs,
            catchUpIntervalMs: media.clientCatchUpIntervalMs,
            enterToSend,
            resolveKeyVerdict,
            isCurrentSession,
            features: { presets, temporary: canTemporary, compare: canCompare },
            ...actions,
          }
        : undefined,
    [
      media,
      scope,
      userId,
      isAuthenticated,
      canUse,
      canCreate,
      balance.data,
      refreshBalance,
      canTemporary,
      canCompare,
      presets,
      enterToSend,
      resolveKeyVerdict,
      isCurrentSession,
      actions,
    ],
  );
  return {
    host,
    media,
    canUse,
    userId,
    loading: !isAuthReady || startupQuery.isLoading,
    failed: startupQuery.isError,
    reload: startupQuery.refetch,
  };
}
