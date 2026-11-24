import { productDeviceSchema } from 'librechat-data-provider';
import type { ProductDevice } from 'librechat-data-provider';
import { getClientPlatform } from '~/lib/rum/redact';

type DeviceNavigator = Pick<Navigator, 'userAgent' | 'maxTouchPoints'>;

function getDeviceType(userAgent: string, maxTouchPoints: number): ProductDevice['type'] {
  if (/Tablet/i.test(userAgent)) return 'tablet';
  if (/iPhone|iPod|Mobile/i.test(userAgent)) return 'phone';
  if (/Android/i.test(userAgent)) return 'tablet';
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return 'tablet';
  return /Windows|Macintosh|Linux|CrOS/.test(userAgent) ? 'desktop' : 'unknown';
}

/** Device class and browser and OS families only. The user agent never leaves the browser. */
export function getProductDevice(nav: DeviceNavigator = navigator): ProductDevice | undefined {
  const { userAgent, maxTouchPoints } = nav;
  /** iPadOS in desktop mode reports a Macintosh user agent. */
  const iPad = /iPad/i.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  const parsed = productDeviceSchema.safeParse({
    ...getClientPlatform(userAgent),
    type: iPad ? 'tablet' : getDeviceType(userAgent, maxTouchPoints),
    ...(iPad ? { os: 'iOS' } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}
