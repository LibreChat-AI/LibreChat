import { getProductDevice } from '../productDevice';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0';

it.each([
  [IPHONE, 0, { type: 'phone', browser: 'Safari', os: 'iOS' }],
  [IPAD_DESKTOP, 5, { type: 'tablet', browser: 'Safari', os: 'iOS' }],
  [IPAD_DESKTOP, 0, { type: 'desktop', browser: 'Safari', os: 'macOS' }],
  [ANDROID_TABLET, 5, { type: 'tablet', browser: 'Chrome', os: 'Android' }],
  [ANDROID_PHONE, 5, { type: 'phone', browser: 'Chrome', os: 'Android' }],
  [WINDOWS_EDGE, 0, { type: 'desktop', browser: 'Edge', os: 'Windows' }],
  ['curl/8.0', 0, { type: 'unknown', browser: 'Other', os: 'Other' }],
])('classifies %s with %s touch points', (userAgent, maxTouchPoints, expected) => {
  expect(getProductDevice({ userAgent, maxTouchPoints })).toEqual(expected);
});
