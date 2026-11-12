import { createStorageAtom } from './jotai-utils';

export type AnalyticsConsent = 'granted' | 'denied';

/** The viewer's answer to the analytics consent banner. `null` means they have
 *  not answered yet, which counts as no consent: Google Tag Manager loads only
 *  after an explicit `granted`. */
export const analyticsConsentAtom = createStorageAtom<AnalyticsConsent | null>(
  'analyticsConsent',
  null,
);

/** Whether the deployment configured Google Tag Manager at all. */
export function hasAnalyticsGtmId(gtmId: string | null | undefined): gtmId is string {
  return typeof gtmId === 'string' && gtmId.trim() !== '';
}
