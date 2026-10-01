import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { AgentCapabilities, PermissionTypes, Permissions } from 'librechat-data-provider';
import type { SettingsContextValue } from './types';
import useProviderKeys from '../SettingsTabs/ProviderKeys/useProviderKeys';
import { useHasAccess, useAuthContext, useGetAgentsConfig } from '~/hooks';
import usePersonalizationAccess from '~/hooks/usePersonalizationAccess';
import { useGetStartupConfig } from '~/data-provider';
import store from '~/store';

export function useSettingsContext(): SettingsContextValue {
  const { user } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const { agentsConfig } = useGetAgentsConfig();
  const { hasAnyPersonalizationFeature, hasMemoryOptOut } = usePersonalizationAccess();

  const hasRemoteAgents = useHasAccess({
    permissionType: PermissionTypes.REMOTE_AGENTS,
    permission: Permissions.USE,
  });
  const hasMultiConvo = useHasAccess({
    permissionType: PermissionTypes.MULTI_CONVO,
    permission: Permissions.USE,
  });
  const hasPrompts = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.USE,
  });

  const balanceEnabled = startupConfig?.balance?.enabled === true;
  const langfuseConnectionAccess = startupConfig?.langfuseConnectionAccess === true;
  const adminPanelURL = startupConfig?.adminPanelURL ?? '';
  const isLocalProvider = user?.provider === 'local';
  const emailEnabled = startupConfig?.emailEnabled === true;
  const allowEmailChange = startupConfig?.allowEmailChange === true;
  const passkeyLoginEnabled = startupConfig?.passkeyLoginEnabled === true;
  const twoFactorEnabled = user?.twoFactorEnabled === true;
  const allowAccountDeletion = startupConfig?.allowAccountDeletion !== false;
  const aboutEnabled = startupConfig?.interface?.buildInfo !== false;
  /* Offered only once the deployment has answered, matching the capability hook the alerts
     read: before then a toggle could store a preference, or raise the browser's permission
     prompt, for a capability the operator turns off. */
  const replyConfigLoaded = startupConfig != null;
  const replyNotificationsConfig = startupConfig?.interface?.replyNotifications;
  const replyTabBadgeAllowed = replyConfigLoaded && replyNotificationsConfig?.tabBadge !== false;
  const replyNotificationsAllowed =
    replyConfigLoaded && replyNotificationsConfig?.desktop !== false;
  const replyNotificationSoundAllowed =
    replyConfigLoaded && replyNotificationsConfig?.sound !== false;
  const hasRemoteAgentsBool = hasRemoteAgents === true;
  const hasMultiConvoBool = hasMultiConvo === true;
  const hasPromptsBool = hasPrompts === true;
  const engineTTS = useRecoilValue<string>(store.engineTTS);
  const hasUserProvidedEndpoints = useProviderKeys().length > 0;
  const hasStatefulCodeSessions =
    agentsConfig?.capabilities.includes(AgentCapabilities.stateful_code_sessions) ?? false;

  return useMemo(
    () => ({
      balanceEnabled,
      hasAnyPersonalizationFeature,
      hasMemoryOptOut,
      hasStatefulCodeSessions,
      hasRemoteAgents: hasRemoteAgentsBool,
      hasUserProvidedEndpoints,
      hasMultiConvo: hasMultiConvoBool,
      hasPrompts: hasPromptsBool,
      isLocalProvider,
      emailEnabled,
      allowEmailChange,
      passkeyLoginEnabled,
      twoFactorEnabled,
      allowAccountDeletion,
      aboutEnabled,
      engineTTS,
      langfuseConnectionAccess,
      adminPanelURL,
      replyTabBadgeAllowed,
      replyNotificationsAllowed,
      replyNotificationSoundAllowed,
    }),
    [
      balanceEnabled,
      hasAnyPersonalizationFeature,
      hasMemoryOptOut,
      hasStatefulCodeSessions,
      hasRemoteAgentsBool,
      hasUserProvidedEndpoints,
      hasMultiConvoBool,
      hasPromptsBool,
      isLocalProvider,
      emailEnabled,
      allowEmailChange,
      passkeyLoginEnabled,
      twoFactorEnabled,
      allowAccountDeletion,
      aboutEnabled,
      engineTTS,
      langfuseConnectionAccess,
      adminPanelURL,
      replyTabBadgeAllowed,
      replyNotificationsAllowed,
      replyNotificationSoundAllowed,
    ],
  );
}
