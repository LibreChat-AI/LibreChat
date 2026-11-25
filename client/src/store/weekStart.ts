import { createStorageAtom } from './jotai-utils';

export type WeekStartPreference = 'system' | 'sunday' | 'monday';

const DEFAULT_WEEK_START: WeekStartPreference = 'system';

export const weekStartAtom = createStorageAtom<WeekStartPreference>(
  'weekStart',
  DEFAULT_WEEK_START,
);
