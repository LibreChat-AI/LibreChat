import { createStorageAtom } from './jotai-utils';

export type ClockFormatPreference = 'system' | '12h' | '24h';

const DEFAULT_CLOCK_FORMAT: ClockFormatPreference = 'system';

export const clockFormatAtom = createStorageAtom<ClockFormatPreference>(
  'clockFormat',
  DEFAULT_CLOCK_FORMAT,
);
