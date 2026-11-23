import type { FeetMode } from './body';

export interface Point {
  x: number;
  y: number;
}

/** A surface Lia can stand on, in the stage's pixel coordinates. */
export interface Platform {
  y: number;
  x0: number;
  x1: number;
}

export type SayKey =
  | 'hi'
  | 'hmm'
  | 'haha'
  | 'yay'
  | 'oops'
  | 'brb'
  | 'gg'
  | 'wow'
  | 'beep'
  | 'okay'
  | 'boo'
  | 'thatsMe'
  | 'ready';

/** Words are localized by the host; symbols are drawn as they are. */
export type Bubble = { say: SayKey } | { symbol: '?' | '!' | '...' | '♥' | 'Zzz' };

export type Look = 'pointer' | 'caret' | 'up' | 'down' | 'left' | 'right';

export type MoveStyle =
  | 'walk'
  | 'tiptoe'
  | 'run'
  | 'hop'
  | 'moonwalk'
  | 'skip'
  | 'sneak'
  | 'march'
  | 'slide'
  | 'wobble'
  | 'shuffle'
  | 'dash'
  | 'teleport';

export type MoveTarget = 'random' | 'near' | 'left' | 'right' | 'pointer';

/** What Lia shows during a step. Values persist into later steps until changed. */
export interface Channels {
  /** Expression key; `null` falls back to Lia's mood. */
  f?: string | null;
  /** Screen program; `face` shows the face. */
  s?: string;
  /** Arm pose. */
  a?: string;
  /** Body pose; `null` clears it. */
  o?: string | null;
  ft?: FeetMode;
  b?: Bubble | null;
  look?: Look | null;
}

export interface StepSpec extends Channels {
  /** Walk somewhere; the step lasts until Lia arrives. */
  m?: { to: MoveTarget; style?: MoveStyle };
}

/** A step lasts a fixed time, a random time in a range, or until a move finishes. */
export type Duration = number | readonly [number, number] | 'move';
export type Step = readonly [Duration, StepSpec];

/** Translation key for something Lia does, shown when hovering her. */
export type LabelKey = `com_ui_lia_${string}`;

export type Category = 'life' | 'emote' | 'say' | 'gesture' | 'dance' | 'travel' | 'react';

export interface ActionDef {
  id: string;
  label: LabelKey;
  cat: Category;
  steps: readonly Step[];
  /** Relative weight within its category when Lia chooses for herself. */
  weight: number;
  tags: readonly ('sleepy' | 'energetic' | 'rest')[];
  /** Played only in response to something, never chosen at random. */
  noAuto: boolean;
  /** Moves across the platform, so reduced motion and a busy user skip it. */
  moves: boolean;
}
