import type { MediaStartupConfig, MediaUserKey } from 'librechat-data-provider';

export type MediaKeyConfiguration = MediaUserKey & { label: string; conflict: boolean };

/** Image/video connections can share a saved key, including its user-supplied URL. */
export function mergeMediaUserKeys(integrations: MediaStartupConfig['integrations']) {
  const keys = new Map<string, MediaKeyConfiguration>();
  for (const integration of integrations ?? []) {
    const key = integration.userKey;
    if (!key) continue;
    const previous = keys.get(key.keyName);
    keys.set(key.keyName, {
      ...key,
      label: previous?.label ?? integration.connectionName,
      userProvideURL: key.userProvideURL || !!previous?.userProvideURL,
      conflict: !!previous?.conflict || (!!previous && previous.encoding !== key.encoding),
    });
  }
  return keys;
}
