import { isSafeLinkUrl } from 'librechat-data-provider';
import type { TTermsOfService } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

type InterfaceConfig = NonNullable<AppConfig['interfaceConfig']>;

type PreLoginInterface = Pick<
  InterfaceConfig,
  'privacyPolicy' | 'termsOfService' | 'buildInfo' | 'theme'
>;

type PolicyLinks = Pick<InterfaceConfig, 'privacyPolicy' | 'termsOfService'>;

const POLICY_LINK_FIELDS = ['privacyPolicy', 'termsOfService'] as const;

type YamlNode = { [key: string]: YamlValue };
type YamlValue = string | number | boolean | null | undefined | YamlNode | YamlValue[];

export interface ConfigPolicyLinkCheck {
  /** The config to validate and return: the input itself unless a link had to be dropped. */
  config: unknown;
  /** The `externalUrl` paths that were dropped. */
  dropped: string[];
}

function isYamlNode(value: unknown): value is YamlNode {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** The policy link without its `externalUrl` when `isSafeLinkUrl` refuses it. */
function withSafeExternalUrl<T extends Pick<TTermsOfService, 'externalUrl'>>(
  link: T | undefined,
): T | undefined {
  if (!link) {
    return link;
  }
  const externalUrl: unknown = link.externalUrl;
  if (externalUrl == null || (typeof externalUrl === 'string' && isSafeLinkUrl(externalUrl))) {
    return link;
  }
  return { ...link, externalUrl: undefined };
}

/**
 * The interface config as a client may render it: a privacy policy or terms of service
 * `externalUrl` that `isSafeLinkUrl` refuses (`javascript:`, `data:` and the like) is removed, so
 * it never becomes an `href`. Admin writes already refuse such a value, the YAML loader drops one
 * from librechat.yaml, and the merge drops one stored before that; this keeps every payload that
 * carries the links (signed out, signed in, shared link) safe on its own, whatever key or path
 * the value arrived by. Returns the same object when nothing is removed.
 */
export function withSafePolicyLinks<T extends PolicyLinks | null | undefined>(
  interfaceConfig: T,
): T {
  if (!interfaceConfig) {
    return interfaceConfig;
  }
  const privacyPolicy = withSafeExternalUrl(interfaceConfig.privacyPolicy);
  const termsOfService = withSafeExternalUrl(interfaceConfig.termsOfService);
  if (
    privacyPolicy === interfaceConfig.privacyPolicy &&
    termsOfService === interfaceConfig.termsOfService
  ) {
    return interfaceConfig;
  }
  return { ...interfaceConfig, privacyPolicy, termsOfService };
}

/**
 * Drops a librechat.yaml policy link `externalUrl` that `isSafeLinkUrl` refuses, before the
 * config is validated, so the deployment publishes no link for it and the rest of the config
 * still loads, as an invalid `interface.theme` does. Admin writes of such a value are refused
 * instead, and every payload removes one that reaches it another way. A config whose links are
 * all safe is returned as the same object.
 */
export function checkConfigPolicyLinks(config: unknown): ConfigPolicyLinkCheck {
  if (!isYamlNode(config) || !isYamlNode(config.interface)) {
    return { config, dropped: [] };
  }
  const interfaceConfig = config.interface;
  const dropped: string[] = [];
  const checked: YamlNode = { ...interfaceConfig };
  for (const field of POLICY_LINK_FIELDS) {
    const link = interfaceConfig[field];
    if (!isYamlNode(link) || typeof link.externalUrl !== 'string') {
      continue;
    }
    if (isSafeLinkUrl(link.externalUrl)) {
      continue;
    }
    const { externalUrl: _dropped, ...rest } = link;
    checked[field] = rest;
    dropped.push(`interface.${field}.externalUrl`);
  }
  if (dropped.length === 0) {
    return { config, dropped };
  }
  return { config: { ...config, interface: checked }, dropped };
}

/**
 * Selects the interface fields a signed-out client may see: the legal links the
 * login page renders (safe links only), a disabled build-info flag,
 * and the deployment theme so the login page paints it instead of switching after
 * sign-in. Returns `undefined` when none of them is configured, so the payload
 * omits `interface` entirely.
 */
export function buildPreLoginInterface(
  interfaceConfig?: AppConfig['interfaceConfig'],
): PreLoginInterface | undefined {
  if (!interfaceConfig) {
    return undefined;
  }
  const { privacyPolicy, termsOfService, buildInfo, theme } = withSafePolicyLinks(interfaceConfig);
  const selected: PreLoginInterface = {
    ...(privacyPolicy && { privacyPolicy }),
    ...(termsOfService && { termsOfService }),
    ...(buildInfo === false && { buildInfo }),
    ...(theme && { theme }),
  };
  return Object.keys(selected).length > 0 ? selected : undefined;
}
