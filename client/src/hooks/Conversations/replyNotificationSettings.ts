import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { TReplyNotificationsConfig } from 'librechat-data-provider';
import { createStorageAtom } from '~/store/jotai-utils';
import { useGetStartupConfig } from '~/data-provider';

/**
 * Reply-notification preferences, owned by the hooks in this directory: the settings toggles
 * write them and `useReplyAlerts`, `useReplyWatcher` and `useUnseenBadge` are their only readers,
 * so they live with the feature rather than in the global store.
 *
 * Per device rather than per account: browser notification permission and audio output are
 * properties of the machine you are sitting at, so wanting a chime on a laptop implies nothing
 * about wanting one on a phone. The seen state they react to does sync.
 */
export const unseenTabBadgeAtom = createStorageAtom<boolean>('unseenTabBadge', true);
export const replyNotificationsAtom = createStorageAtom<boolean>('replyNotifications', false);
export const replyNotificationSoundAtom = createStorageAtom<boolean>(
  'replyNotificationSound',
  false,
);

/**
 * What the deployment allows, independent of what this device prefers.
 *
 * Mirrors `interface.replyNotifications` in `librechat.yaml`. The fallbacks reproduce the
 * shipped behavior for a server that predates the setting or answers without it, so a client
 * held against an older backend behaves as it did before the gate existed.
 */
export const REPLY_NOTIFICATION_DEFAULTS: Required<TReplyNotificationsConfig> = {
  tabBadge: true,
  desktop: true,
  sound: true,
  pollLimit: 100,
  pollIntervalMs: 30_000,
  focusedRefreshMs: 300_000,
};

const isWithin =
  (min: number, max: number) =>
  (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const isBounded = isWithin(1, 100);
const isPollInterval = isWithin(10_000, 600_000);
const isFocusedRefresh = isWithin(60_000, 300_000);

/** Nothing is permitted until the deployment has answered. */
const PENDING_CAPABILITIES: Required<TReplyNotificationsConfig> = {
  ...REPLY_NOTIFICATION_DEFAULTS,
  tabBadge: false,
  desktop: false,
  sound: false,
};

/**
 * The reply-alert capabilities this deployment permits.
 *
 * Off until the startup config has loaded: a device that stored "on" would otherwise badge,
 * poll or notify in the window before an operator's `false` arrives. Once a config is in hand,
 * a missing field means a backend that predates the setting, and reads as the shipped default.
 *
 * Every field is re-checked rather than trusted from the payload: a cached startup config can
 * outlive the schema that produced it, and an out-of-range poll limit would otherwise reach the
 * list request as a page size the server has to clamp.
 */
export function useReplyNotificationCapabilities(): Required<TReplyNotificationsConfig> {
  const { data: startupConfig } = useGetStartupConfig();
  const loaded = startupConfig != null;
  const configured = startupConfig?.interface?.replyNotifications;
  return useMemo(() => {
    if (!loaded) {
      return PENDING_CAPABILITIES;
    }
    return {
      tabBadge: configured?.tabBadge !== false,
      desktop: configured?.desktop !== false,
      sound: configured?.sound !== false,
      pollLimit: isBounded(configured?.pollLimit)
        ? configured.pollLimit
        : REPLY_NOTIFICATION_DEFAULTS.pollLimit,
      pollIntervalMs: isPollInterval(configured?.pollIntervalMs)
        ? configured.pollIntervalMs
        : REPLY_NOTIFICATION_DEFAULTS.pollIntervalMs,
      focusedRefreshMs: isFocusedRefresh(configured?.focusedRefreshMs)
        ? configured.focusedRefreshMs
        : REPLY_NOTIFICATION_DEFAULTS.focusedRefreshMs,
    };
  }, [
    loaded,
    configured?.tabBadge,
    configured?.desktop,
    configured?.sound,
    configured?.pollLimit,
    configured?.pollIntervalMs,
    configured?.focusedRefreshMs,
  ]);
}

/** What this device wants, once the deployment's gate has been applied to it. */
export interface ReplyAlertPreferences {
  badgeEnabled: boolean;
  notificationsEnabled: boolean;
  soundEnabled: boolean;
  pollLimit: number;
  pollIntervalMs: number;
  focusedRefreshMs: number;
}

/**
 * A capability the operator turned off reads as off here whatever this device stored, so a
 * preference saved before the gate closed cannot keep announcing replies.
 */
export function useReplyAlertPreferences(): ReplyAlertPreferences {
  const capabilities = useReplyNotificationCapabilities();
  const badgePreferred = useAtomValue(unseenTabBadgeAtom);
  const notificationsPreferred = useAtomValue(replyNotificationsAtom);
  const soundPreferred = useAtomValue(replyNotificationSoundAtom);
  return useMemo(
    () => ({
      badgeEnabled: capabilities.tabBadge && badgePreferred,
      notificationsEnabled: capabilities.desktop && notificationsPreferred,
      soundEnabled: capabilities.sound && soundPreferred,
      pollLimit: capabilities.pollLimit,
      pollIntervalMs: capabilities.pollIntervalMs,
      focusedRefreshMs: capabilities.focusedRefreshMs,
    }),
    [capabilities, badgePreferred, notificationsPreferred, soundPreferred],
  );
}
