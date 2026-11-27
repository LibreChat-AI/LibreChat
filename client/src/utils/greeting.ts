import type { TranslationKeys } from '~/hooks/useLocalize';

export type GreetingOption = {
  key: TranslationKeys;
  namedKey: TranslationKeys;
};

export type GreetingSlot = {
  until: number;
  options: GreetingOption[];
};

export type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export const dayKeys: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const lateNight: GreetingOption[] = [
  { key: 'com_ui_greeting_up_late', namedKey: 'com_ui_greeting_up_late_named' },
  { key: 'com_ui_greeting_still_up', namedKey: 'com_ui_greeting_still_up_named' },
  { key: 'com_ui_greeting_think_through', namedKey: 'com_ui_greeting_think_through_named' },
];

/** 04:00 to 07:00, where the visitor could be up early or not yet in bed. */
const dawn: GreetingOption[] = [
  { key: 'com_ui_greeting_bird_or_owl', namedKey: 'com_ui_greeting_bird_or_owl_named' },
  { key: 'com_ui_greeting_up_already', namedKey: 'com_ui_greeting_up_already_named' },
  { key: 'com_ui_greeting_before_sun', namedKey: 'com_ui_greeting_before_sun_named' },
  { key: 'com_ui_greeting_early_bird', namedKey: 'com_ui_greeting_early_bird_named' },
];

const morning: GreetingOption[] = [
  { key: 'com_ui_greeting_good_morning', namedKey: 'com_ui_greeting_good_morning_named' },
  { key: 'com_ui_greeting_first_move', namedKey: 'com_ui_greeting_first_move_named' },
  { key: 'com_ui_greeting_ready', namedKey: 'com_ui_greeting_ready_named' },
];

const afternoon: GreetingOption[] = [
  { key: 'com_ui_greeting_good_afternoon', namedKey: 'com_ui_greeting_good_afternoon_named' },
  { key: 'com_ui_greeting_day_going', namedKey: 'com_ui_greeting_day_going_named' },
  { key: 'com_ui_greeting_working_on', namedKey: 'com_ui_greeting_working_on_named' },
];

const evening: GreetingOption[] = [
  { key: 'com_ui_greeting_good_evening', namedKey: 'com_ui_greeting_good_evening_named' },
  { key: 'com_ui_greeting_winding_down', namedKey: 'com_ui_greeting_winding_down_named' },
  { key: 'com_ui_greeting_whats_left', namedKey: 'com_ui_greeting_whats_left_named' },
];

const cooking: GreetingOption = {
  key: 'com_ui_greeting_cooking',
  namedKey: 'com_ui_greeting_cooking_named',
};

const welcomeBack: GreetingOption = {
  key: 'com_ui_greeting_returns',
  namedKey: 'com_ui_greeting_returns_named',
};

const newWeek: GreetingOption = {
  key: 'com_ui_greeting_new_week',
  namedKey: 'com_ui_greeting_new_week_named',
};

const backAtIt: GreetingOption = {
  key: 'com_ui_greeting_back_at_it',
  namedKey: 'com_ui_greeting_back_at_it_named',
};

const eveningShift: GreetingOption = {
  key: 'com_ui_greeting_evening_shift',
  namedKey: 'com_ui_greeting_evening_shift_named',
};

const happyThursday: GreetingOption = {
  key: 'com_ui_greeting_happy_thursday',
  namedKey: 'com_ui_greeting_happy_thursday_named',
};

const coffee: GreetingOption = {
  key: 'com_ui_greeting_coffee',
  namedKey: 'com_ui_greeting_coffee_named',
};

const tackle: GreetingOption = {
  key: 'com_ui_greeting_tackle',
  namedKey: 'com_ui_greeting_tackle_named',
};

export const defaultGreetingSlots: GreetingSlot[] = [
  { until: 4, options: lateNight },
  { until: 7, options: dawn },
  { until: 12, options: morning },
  { until: 17, options: afternoon },
  { until: 22, options: evening },
  { until: 24, options: lateNight },
];

export const greetingSlotsByDay: Partial<Record<DayKey, GreetingSlot[]>> = {
  sun: [
    { until: 4, options: lateNight },
    { until: 7, options: dawn },
    { until: 12, options: [...morning, cooking] },
    { until: 17, options: afternoon },
    { until: 22, options: [...evening, welcomeBack] },
    { until: 24, options: lateNight },
  ],

  mon: [
    { until: 4, options: lateNight },
    { until: 7, options: dawn },
    { until: 12, options: [...morning, newWeek] },
    { until: 17, options: [...afternoon, backAtIt] },
    { until: 22, options: [...evening, eveningShift] },
    { until: 24, options: lateNight },
  ],

  wed: [
    { until: 4, options: lateNight },
    { until: 7, options: dawn },
    { until: 12, options: morning },
    { until: 17, options: afternoon },
    { until: 22, options: [...evening, welcomeBack] },
    { until: 24, options: lateNight },
  ],

  thu: [
    { until: 4, options: lateNight },
    { until: 7, options: dawn },
    { until: 12, options: [...morning, happyThursday] },
    { until: 17, options: afternoon },
    { until: 22, options: evening },
    { until: 24, options: lateNight },
  ],

  fri: [
    { until: 4, options: lateNight },
    { until: 7, options: dawn },
    { until: 12, options: morning },
    { until: 17, options: afternoon },
    { until: 22, options: [...evening, eveningShift] },
    { until: 24, options: lateNight },
  ],

  sat: [
    { until: 4, options: lateNight },
    { until: 7, options: dawn },
    { until: 12, options: [...morning, coffee] },
    { until: 17, options: [...afternoon, tackle] },
    { until: 22, options: evening },
    { until: 24, options: lateNight },
  ],
};

const getSlots = (date: Date): GreetingSlot[] =>
  greetingSlotsByDay[dayKeys[date.getDay()]] ?? defaultGreetingSlots;

const getSlotIndex = (slots: GreetingSlot[], hours: number): number => {
  const index = slots.findIndex((slot) => hours < slot.until);
  return index === -1 ? slots.length - 1 : index;
};

/** Local calendar day as a whole number, so a slot's variant holds for the whole day. */
const getDayNumber = (date: Date): number =>
  Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);

/** Slot for the given local date/time, from the day's schedule or the default one. */
export const getGreetingSlot = (date: Date = new Date()): GreetingSlot => {
  const slots = getSlots(date);
  return slots[getSlotIndex(slots, date.getHours())];
};

/**
 * Variant for the given local date/time. The choice rotates by calendar day, so the
 * greeting holds steady across a slot but differs from one day to the next.
 */
export const getGreetingOption = (date: Date = new Date()): GreetingOption => {
  const slots = getSlots(date);
  const slotIndex = getSlotIndex(slots, date.getHours());
  const { options } = slots[slotIndex];
  return options[(getDayNumber(date) + slotIndex) % options.length];
};

/** Translation key for the greeting, preferring the personalized variant when named. */
export const getGreetingKey = (date: Date = new Date(), hasName = false): TranslationKeys => {
  const option = getGreetingOption(date);
  return hasName ? option.namedKey : option.key;
};

/** Milliseconds from `date` until the current greeting slot expires (local time). */
export const getMsUntilNextGreeting = (date: Date = new Date()): number => {
  const boundary = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    getGreetingSlot(date).until,
    0,
    0,
    0,
  );
  return boundary.getTime() - date.getTime();
};
