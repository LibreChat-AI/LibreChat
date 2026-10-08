import type { TInterfaceConfig } from 'librechat-data-provider';

type PreLoginInterface = Pick<
  TInterfaceConfig,
  'privacyPolicy' | 'termsOfService' | 'buildInfo' | 'theme' | 'visuals'
>;

/**
 * Selects the interface fields a signed-out client may see: the legal links the
 * login page renders, a disabled build-info flag, and the deployment theme so the
 * login page paints it instead of switching after sign-in, and a disabled visuals flag so a
 * shared conversation viewed signed out does not render visuals. Returns `undefined`
 * when none of them is configured, so the payload omits `interface` entirely.
 */
export function buildPreLoginInterface(
  interfaceConfig?: Partial<TInterfaceConfig>,
): PreLoginInterface | undefined {
  if (!interfaceConfig) {
    return undefined;
  }
  const { privacyPolicy, termsOfService, buildInfo, theme, visuals } = interfaceConfig;
  const selected: PreLoginInterface = {
    ...(privacyPolicy && { privacyPolicy }),
    ...(termsOfService && { termsOfService }),
    ...(buildInfo === false && { buildInfo }),
    ...(theme && { theme }),
    ...(visuals === false && { visuals }),
  };
  return Object.keys(selected).length > 0 ? selected : undefined;
}
