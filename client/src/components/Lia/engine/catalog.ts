import type { ActionDef, Category, LabelKey, MoveStyle, SayKey, Step, StepSpec } from './types';
import { EXPRESSIONS } from './face';

type Options = Partial<Pick<ActionDef, 'weight' | 'tags' | 'noAuto'>>;

const actions: ActionDef[] = [];

function add(
  id: string,
  label: LabelKey,
  cat: Category,
  steps: readonly Step[],
  opts: Options = {},
) {
  actions.push({
    id,
    label,
    cat,
    steps,
    weight: opts.weight ?? 1,
    tags: opts.tags ?? [],
    noAuto: opts.noAuto ?? cat === 'react',
    moves: steps.some(([, spec]) => spec.m != null),
  });
}
const step = (dur: Step[0], spec: StepSpec = {}): Step => [dur, spec];

/* ---------- Feelings: one per expression ---------- */
for (const ex of EXPRESSIONS) {
  add(`feel-${ex.key}`, ex.label, 'emote', [
    step([1500, 2300], { f: ex.key, a: ex.arms ?? 'none', o: ex.pose ?? null }),
    step(300),
  ]);
}

/* ---------- Speech ---------- */
const SAYINGS: ReadonlyArray<readonly [SayKey, LabelKey, string, string?]> = [
  ['hi', 'com_ui_lia_act_say_hi', 'happy', 'wave'],
  ['hmm', 'com_ui_lia_act_say_hmm', 'thinking', 'scratch'],
  ['haha', 'com_ui_lia_act_say_haha', 'laughing'],
  ['yay', 'com_ui_lia_act_say_yay', 'joyful', 'cheer'],
  ['oops', 'com_ui_lia_act_say_oops', 'embarrassed', 'facepalm'],
  ['brb', 'com_ui_lia_act_say_brb', 'neutral', 'salute'],
  ['gg', 'com_ui_lia_act_say_gg', 'proud', 'thumbs'],
  ['wow', 'com_ui_lia_act_say_wow', 'amazed'],
  ['beep', 'com_ui_lia_act_say_beep', 'deadpan', 'robot'],
  ['okay', 'com_ui_lia_act_say_okay', 'wink', 'thumbs'],
];
for (const [say, label, f, a] of SAYINGS) {
  add(`say-${say}`, label, 'say', [
    step(1800, { b: { say }, f, a: a ?? 'none' }),
    step(300, { b: null }),
  ]);
}
add('say-dots', 'com_ui_lia_act_say_dots', 'say', [
  step(1800, { b: { symbol: '...' }, f: 'deadpan' }),
  step(300, { b: null }),
]);
add('say-love', 'com_ui_lia_act_say_love', 'say', [
  step(1800, { b: { symbol: '♥' }, f: 'love', a: 'hug' }),
  step(300, { b: null }),
]);

/* ---------- Gestures ---------- */
const GESTURES: ReadonlyArray<
  readonly [arm: string, label: LabelKey, face: string, pose?: string]
> = [
  ['wave', 'com_ui_lia_act_gesture_wave', 'happy'],
  ['waveL', 'com_ui_lia_act_gesture_waveL', 'happy'],
  ['waveBoth', 'com_ui_lia_act_gesture_waveBoth', 'joyful', 'bounce'],
  ['cheer', 'com_ui_lia_act_gesture_cheer', 'excited', 'bounce'],
  ['clap', 'com_ui_lia_act_gesture_clap', 'joyful'],
  ['shrug', 'com_ui_lia_act_gesture_shrug', 'deadpan'],
  ['pointL', 'com_ui_lia_act_gesture_pointL', 'curious'],
  ['pointR', 'com_ui_lia_act_gesture_pointR', 'curious'],
  ['pointUp', 'com_ui_lia_act_gesture_pointUp', 'amazed'],
  ['pointDown', 'com_ui_lia_act_gesture_pointDown', 'curious'],
  ['hips', 'com_ui_lia_act_gesture_hips', 'proud', 'tiptoe'],
  ['facepalm', 'com_ui_lia_act_gesture_facepalm', 'embarrassed'],
  ['scratch', 'com_ui_lia_act_gesture_scratch', 'confused'],
  ['stretch', 'com_ui_lia_act_gesture_stretch', 'content', 'stretchUp'],
  ['flex', 'com_ui_lia_act_gesture_flex', 'determined'],
  ['hug', 'com_ui_lia_act_gesture_hug', 'love'],
  ['salute', 'com_ui_lia_act_gesture_salute', 'determined'],
  ['thumbs', 'com_ui_lia_act_gesture_thumbs', 'wink'],
  ['thumbsBoth', 'com_ui_lia_act_gesture_thumbsBoth', 'joyful'],
  ['rub', 'com_ui_lia_act_gesture_rub', 'sleepy'],
  ['cover', 'com_ui_lia_act_gesture_cover', 'shy'],
  ['conduct', 'com_ui_lia_act_gesture_conduct', 'focused', 'sway'],
  ['airguitar', 'com_ui_lia_act_gesture_airguitar', 'excited', 'headbang'],
  ['jazz', 'com_ui_lia_act_gesture_jazz', 'starstruck', 'bounce'],
  ['box', 'com_ui_lia_act_gesture_box', 'determined', 'stomp'],
  ['swim', 'com_ui_lia_act_gesture_swim', 'happy', 'float'],
  ['drum', 'com_ui_lia_act_gesture_drum', 'excited'],
  ['reach', 'com_ui_lia_act_gesture_reach', 'hopeful', 'tiptoe'],
  ['tpose', 'com_ui_lia_act_gesture_tpose', 'deadpan'],
  ['pray', 'com_ui_lia_act_gesture_pray', 'zen'],
  ['knock', 'com_ui_lia_act_gesture_knock', 'curious'],
  ['fan', 'com_ui_lia_act_gesture_fan', 'tired'],
  ['bow', 'com_ui_lia_act_gesture_bow', 'proud', 'bow'],
  ['shield', 'com_ui_lia_act_gesture_shield', 'scared', 'crouch'],
  ['catch', 'com_ui_lia_act_gesture_catch', 'focused', 'crouch'],
];
for (const [a, label, f, o] of GESTURES) {
  add(`gesture-${a}`, label, 'gesture', [
    step([1500, 2200], { a, f, o: o ?? null }),
    step(300, { a: 'none', o: null }),
  ]);
}

/* ---------- Dances ---------- */
add('dance-wiggle', 'com_ui_lia_act_dance_wiggle', 'dance', [
  step(3000, { a: 'jazz', o: 'wiggle', f: 'joyful', ft: 'tap' }),
]);
add('dance-robot', 'com_ui_lia_act_dance_robot', 'dance', [
  step(3200, { a: 'robot', o: 'robot', f: 'deadpan', b: { say: 'beep' } }),
]);
add('dance-disco', 'com_ui_lia_act_dance_disco', 'dance', [
  step(3200, { a: 'disco', o: 'disco', f: 'cool' }),
]);
add('dance-twist', 'com_ui_lia_act_dance_twist', 'dance', [
  step(3000, { a: 'out', o: 'twist', f: 'happy', ft: 'slide' }),
]);
add(
  'dance-headbang',
  'com_ui_lia_act_dance_headbang',
  'dance',
  [step(2800, { a: 'airguitar', o: 'headbang', f: 'excited' })],
  {
    tags: ['energetic'],
  },
);
add('dance-spin', 'com_ui_lia_act_dance_spin', 'dance', [
  step(1800, { a: 'cheer', o: 'spin', f: 'joyful' }),
  step(500, { f: 'dizzy', a: 'none', o: 'dizzy' }),
]);
add(
  'dance-cartwheel',
  'com_ui_lia_act_dance_cartwheel',
  'dance',
  [
    step(900, { a: 'tpose', o: 'flip', f: 'excited' }),
    step(600, { a: 'cheer', o: null, f: 'proud' }),
  ],
  { tags: ['energetic'] },
);
add('dance-macarena', 'com_ui_lia_act_dance_macarena', 'dance', [
  step(4500, { a: 'macarena', o: 'sway', f: 'happy' }),
]);
add('dance-ballet', 'com_ui_lia_act_dance_ballet', 'dance', [
  step(1200, { a: 'stretch', o: 'tiptoe', f: 'zen' }),
  step(1400, { o: 'spin' }),
  step(600, { a: 'bow', o: 'bow', f: 'proud' }),
]);
add('dance-victory', 'com_ui_lia_act_dance_victory', 'dance', [
  step(2600, { a: 'cheer', o: 'hop', f: 'excited' }),
]);
add('dance-moonwalk', 'com_ui_lia_act_dance_moonwalk', 'dance', [
  step('move', { m: { to: 'near', style: 'moonwalk' }, a: 'disco', f: 'cool' }),
  step(600, { a: 'salute', f: 'proud' }),
]);
add('dance-tap', 'com_ui_lia_act_dance_tap', 'dance', [
  step(2800, { a: 'hips', ft: 'tap', f: 'happy', o: 'bounce' }),
]);
add(
  'dance-jacks',
  'com_ui_lia_act_dance_jacks',
  'dance',
  [
    step(3000, { a: 'jacks', o: 'hop', f: 'determined' }),
    step(600, { a: 'none', o: null, f: 'tired' }),
  ],
  { tags: ['energetic'] },
);

/* ---------- Travel ---------- */
const SLOW: ReadonlySet<MoveStyle> = new Set(['tiptoe', 'sneak', 'shuffle', 'wobble', 'moonwalk']);
const TRAVEL: ReadonlyArray<readonly [MoveStyle, LabelKey]> = [
  ['walk', 'com_ui_lia_act_travel_walk'],
  ['tiptoe', 'com_ui_lia_act_travel_tiptoe'],
  ['run', 'com_ui_lia_act_travel_run'],
  ['hop', 'com_ui_lia_act_travel_hop'],
  ['moonwalk', 'com_ui_lia_act_travel_moonwalk'],
  ['skip', 'com_ui_lia_act_travel_skip'],
  ['sneak', 'com_ui_lia_act_travel_sneak'],
  ['march', 'com_ui_lia_act_travel_march'],
  ['slide', 'com_ui_lia_act_travel_slide'],
  ['wobble', 'com_ui_lia_act_travel_wobble'],
  ['shuffle', 'com_ui_lia_act_travel_shuffle'],
  ['dash', 'com_ui_lia_act_travel_dash'],
];
function travelFace(style: MoveStyle) {
  if (style === 'sneak') {
    return 'mischievous';
  }
  return style === 'run' || style === 'dash' ? 'determined' : 'happy';
}
for (const [style, label] of TRAVEL) {
  const fast = style === 'run' || style === 'dash';
  add(
    `travel-${style}`,
    label,
    'travel',
    [
      step('move', {
        m: { to: SLOW.has(style) ? 'near' : 'random', style },
        f: travelFace(style),
      }),
      step(400, { f: null }),
    ],
    { weight: style === 'walk' ? 3 : 1, tags: fast || style === 'hop' ? ['energetic'] : [] },
  );
}
add('travel-teleport', 'com_ui_lia_act_travel_teleport', 'travel', [
  step(400, { o: 'collapse', s: 'off' }),
  step('move', { m: { to: 'random', style: 'teleport' } }),
  step(400, { o: 'expand' }),
  step(600, { o: null, s: 'face', f: 'surprised' }),
]);
add('travel-explore', 'com_ui_lia_act_travel_explore', 'travel', [
  step('move', { m: { to: 'random', style: 'walk' }, f: 'curious' }),
  step(1800, { o: 'lookAround' }),
  step(300, { o: null }),
]);

/* ---------- Life ---------- */
add('stretch-yawn', 'com_ui_lia_act_stretch_yawn', 'life', [
  step(1200, { a: 'stretch', f: 'sleepy', o: 'stretchUp' }),
  step(800, { a: 'none', o: null, f: 'content' }),
]);
add('sneeze', 'com_ui_lia_act_sneeze', 'life', [
  step(900, { f: 'sneezy', o: 'sneeze' }),
  step(250, { f: 'hurt', s: 'glitch' }),
  step(700, { s: 'face', o: null, f: 'embarrassed' }),
]);
add('peekaboo', 'com_ui_lia_act_peekaboo', 'life', [
  step(1300, { a: 'cover', f: 'giggle', look: 'pointer' }),
  step(600, { a: 'none', f: 'joyful', b: { say: 'boo' } }),
  step(700, { b: null, f: 'laughing' }),
]);
add('hide-peek', 'com_ui_lia_act_hide_peek', 'life', [
  step(800, { o: 'hide', f: 'mischievous' }),
  step(2200, { o: 'hidden' }),
  step(700, { o: 'emerge', f: 'excited', b: { say: 'boo' } }),
  step(600, { o: null, b: null, f: 'laughing' }),
]);
add(
  'sit-edge',
  'com_ui_lia_act_sit_edge',
  'life',
  [
    step('move', { m: { to: 'right', style: 'walk' } }),
    step(4200, { o: 'sit', ft: 'hidden', f: 'dreamy', look: 'up' }),
    step(400, { o: null, ft: 'stand' }),
  ],
  { tags: ['rest'] },
);
add(
  'nap',
  'com_ui_lia_act_nap',
  'life',
  [
    step(900, { f: 'sleepy', a: 'rub' }),
    step(12000, { a: 'none', f: 'asleep', o: 'sit' }),
    step(10000, { s: 'saver' }),
    step(900, { s: 'face', o: 'stretchUp', a: 'stretch', f: 'content' }),
  ],
  { tags: ['sleepy', 'rest'] },
);
add('trip', 'com_ui_lia_act_trip', 'life', [
  step('move', { m: { to: 'near', style: 'walk' } }),
  step(400, { o: 'fall', f: 'startled' }),
  step(1000, { o: 'lie', f: 'dazed' }),
  step(500, { o: 'getup', f: 'embarrassed' }),
]);
add('look-around', 'com_ui_lia_act_look_around', 'life', [
  step(2600, { o: 'lookAround', f: 'curious' }),
]);
add('hum', 'com_ui_lia_act_hum', 'life', [step(3200, { f: 'whistling', o: 'sway', ft: 'tap' })]);
add('reboot', 'com_ui_lia_act_reboot', 'life', [
  step(600, { s: 'off' }),
  step(1500, { s: 'boot' }),
  step(600, { f: 'happy', s: 'face' }),
]);
add('shake-dust', 'com_ui_lia_act_shake_dust', 'life', [
  step(900, { o: 'shake', f: 'laughing' }),
  step(400, { o: null, f: 'content' }),
]);
add('hiccups', 'com_ui_lia_act_hiccups', 'life', [
  step(500, { f: 'neutral' }),
  step(300, { o: 'jump', f: 'surprised', b: { symbol: '!' } }),
  step(600, { o: null, f: 'neutral', b: null }),
  step(300, { o: 'jump', f: 'surprised', b: { symbol: '!' } }),
  step(700, { o: null, f: 'annoyed', b: null }),
]);
add('stare-contest', 'com_ui_lia_act_stare_contest', 'life', [
  step(2600, { f: 'focused', look: 'pointer' }),
  step(300, { f: 'blushing' }),
  step(800, { f: 'pouting' }),
]);
add('high-five', 'com_ui_lia_act_high_five', 'life', [
  step(1200, { a: 'reach', f: 'hopeful', look: 'pointer' }),
  step(700, { a: 'cheer', f: 'joyful' }),
]);
add('come-closer', 'com_ui_lia_act_come_closer', 'life', [
  step('move', { m: { to: 'pointer', style: 'walk' }, look: 'pointer' }),
  step(1500, { a: 'wave', f: 'happy', look: 'pointer', b: { say: 'hi' } }),
  step(200, { b: null }),
]);
add('sneak-pointer', 'com_ui_lia_act_sneak_pointer', 'life', [
  step('move', { m: { to: 'pointer', style: 'sneak' }, f: 'mischievous', look: 'pointer' }),
  step(700, { b: { say: 'boo' }, f: 'excited', o: 'jump' }),
  step(500, { b: null, o: null }),
]);
add(
  'bounce-around',
  'com_ui_lia_act_bounce_around',
  'life',
  [step(2400, { o: 'hop', f: 'joyful' })],
  {
    tags: ['energetic'],
  },
);
add(
  'screensaver',
  'com_ui_lia_act_screensaver',
  'life',
  [step(6000, { s: 'saver' }), step(300, { s: 'face' })],
  {
    tags: ['rest'],
  },
);

/* ---------- Reactions to the page ---------- */
const react = (id: string, label: LabelKey, steps: readonly Step[]) =>
  add(id, label, 'react', steps);
react('intro', 'com_ui_lia_act_intro', [
  step(300, { o: 'hidden', s: 'off' }),
  step(650, { o: 'emerge' }),
  step(1500, { o: null, s: 'boot' }),
  step(900, { s: 'face', f: 'happy', a: 'wave' }),
]);
react('r-focus', 'com_ui_lia_act_r_focus', [
  step(1000, { f: 'curious', look: 'caret', a: 'wave' }),
]);
react('r-type-fast', 'com_ui_lia_act_r_type_fast', [
  step(1800, { f: 'excited', a: 'type', o: 'bounce', look: 'caret' }),
]);
react('r-paste', 'com_ui_lia_act_r_paste', [
  step(300, { f: 'startled', o: 'jump' }),
  step(1200, { o: null, f: 'amazed', a: 'catch' }),
]);
react('r-long', 'com_ui_lia_act_r_long', [
  step(1600, { f: 'shocked', b: { say: 'wow' } }),
  step(900, { b: null, f: 'determined', a: 'flex' }),
]);
react('r-question', 'com_ui_lia_act_r_question', [
  step(1800, { f: 'thinking', a: 'scratch', b: { symbol: '?' } }),
  step(200, { b: null }),
]);
react('r-exclaim', 'com_ui_lia_act_r_exclaim', [
  step(1100, { f: 'excited', o: 'jump', b: { symbol: '!' } }),
  step(200, { b: null }),
]);
react('r-hello', 'com_ui_lia_act_r_hello', [
  step(1600, { a: 'waveBoth', f: 'joyful', b: { say: 'hi' } }),
  step(200, { b: null }),
]);
react('r-thanks', 'com_ui_lia_act_r_thanks', [step(1400, { a: 'bow', o: 'bow', f: 'blushing' })]);
react('r-name', 'com_ui_lia_act_r_name', [
  step(1800, { f: 'starstruck', a: 'jazz', b: { say: 'thatsMe' }, o: 'bounce' }),
  step(200, { b: null }),
]);
react('r-love', 'com_ui_lia_act_r_love', [
  step(1800, { f: 'love', a: 'hug', b: { symbol: '♥' } }),
  step(200, { b: null }),
]);
react('r-drag', 'com_ui_lia_act_r_drag', [
  step(20000, { s: 'file', a: 'reachBoth', o: 'bounce', b: { say: 'ready' } }),
]);
react('r-drop', 'com_ui_lia_act_r_drop', [
  step(300, { a: 'catch', f: 'startled', b: null }),
  step(1300, { f: 'chewing' }),
  step(500, { f: 'happy' }),
]);
react('r-send', 'com_ui_lia_act_r_send', [
  step(500, { s: 'loading', f: 'focused' }),
  step(700, { s: 'heart', a: 'wave' }),
  step(600, { o: 'hide', a: 'wave' }),
  step(5000, { o: 'hidden' }),
]);
react('r-drag-cancel', 'com_ui_lia_act_r_drag_cancel', [
  step(1100, { f: 'sad', a: 'shrug', b: null }),
]);
react('r-dark', 'com_ui_lia_act_r_dark', [step(2600, { f: 'cool', a: 'thumbs' })]);
react('r-light', 'com_ui_lia_act_r_light', [
  step(1500, { f: 'annoyed', a: 'shield' }),
  step(500, { f: 'happy', a: 'none' }),
]);
react('r-hover', 'com_ui_lia_act_r_hover', [step(1600, { f: 'content', o: 'wiggle' })]);
react('r-near', 'com_ui_lia_act_r_near', [step(1200, { f: 'shy', a: 'hug' })]);
react('r-shake', 'com_ui_lia_act_r_shake', [step(1600, { f: 'dizzy', o: 'dizzy' })]);
const PETS: ReadonlyArray<readonly [string, string | null]> = [
  ['giggle', 'wiggle'],
  ['blushing', null],
  ['catface', 'wiggle'],
  ['joyful', 'spin'],
  ['wink', null],
  ['laughing', 'shake'],
];
PETS.forEach(([f, o], i) => react(`r-pet-${i}`, 'com_ui_lia_act_pet', [step(1000, { f, o })]));
react('r-dizzy', 'com_ui_lia_act_r_dizzy', [step(1700, { f: 'dazed', o: 'dizzy' })]);
react('r-crash', 'com_ui_lia_act_r_crash', [
  step(1900, { s: 'bsod' }),
  step(1500, { s: 'boot' }),
  step(700, { s: 'face', f: 'embarrassed' }),
]);
react('r-welcome', 'com_ui_lia_act_r_welcome', [
  step(1800, { a: 'waveBoth', f: 'joyful', b: { say: 'hi' } }),
  step(200, { b: null }),
]);
react('r-squish', 'com_ui_lia_act_r_squish', [step(800, { o: 'squash', f: 'startled' })]);
react('r-wake', 'com_ui_lia_act_r_wake', [
  step(600, { f: 'startled', o: 'jump', b: { symbol: '!' }, s: 'face' }),
  step(900, { o: null, f: 'sleepy', a: 'rub', b: null }),
]);
react('r-select', 'com_ui_lia_act_r_select', [step(1300, { f: 'surprised', a: 'shrug' })]);

export const ACTIONS: readonly ActionDef[] = actions;
export const ACTION_BY_ID: ReadonlyMap<string, ActionDef> = new Map(actions.map((a) => [a.id, a]));
export const PET_COUNT = PETS.length;
