import type { TranslationKeys } from '~/hooks';
import type { SayKey } from './engine/types';

/** The localized line for each word Lia can say in a speech bubble. */
export const SAY: Readonly<Record<SayKey, TranslationKeys>> = {
  hi: 'com_ui_lia_say_hi',
  hmm: 'com_ui_lia_say_hmm',
  haha: 'com_ui_lia_say_haha',
  yay: 'com_ui_lia_say_yay',
  oops: 'com_ui_lia_say_oops',
  brb: 'com_ui_lia_say_brb',
  gg: 'com_ui_lia_say_gg',
  wow: 'com_ui_lia_say_wow',
  beep: 'com_ui_lia_say_beep',
  okay: 'com_ui_lia_say_okay',
  boo: 'com_ui_lia_say_boo',
  thatsMe: 'com_ui_lia_say_thats_me',
  ready: 'com_ui_lia_say_ready',
};
