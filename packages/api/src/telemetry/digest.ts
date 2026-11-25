/**
 * Names the librechat.yaml a process runs with on its log records and request spans. It is an
 * attribute rather than a resource attribute because the resource is fixed when the SDK starts,
 * before the config loads, and an admin reload can change the config without a restart.
 */
export const CONFIG_DIGEST_ATTRIBUTE = 'librechat.config.digest';

let configDigest: string | undefined;

/** Records the digest of the config that just loaded; the last successful load wins. */
export function setConfigDigest(digest: string): void {
  configDigest = digest;
}

export function getConfigDigest(): string | undefined {
  return configDigest;
}

/** Test hook — not exported from the package barrel. */
export function resetConfigDigestForTests(): void {
  configDigest = undefined;
}
