import type { FaceState } from './face';
import type { Ctx } from './pixels';
import { drawFace, drawBlob, SCREEN_W, SCREEN_H, FEATHER_ROWS, FEATHER_PAL } from './face';
import { C, rect, line, sprite, hash, toggle, easeOut } from './pixels';

/* Lia's canvas is a 64 x 58 grid. The monitor's top-left corner sits at (BX, BY), which leaves
 * room around it for arms and raised hands; feet touch the ground on row FOOT_Y. */
export const GRID_W = 64;
export const GRID_H = 58;
export const BX = 12;
export const BY = 20;
export const SX = BX + 4;
export const SY = BY + 4;
export const FOOT_Y = 57;
/** Rows from the feet up to the top edge of the monitor. */
export const HEAD_ROWS = FOOT_Y - BY;

export type FeetMode =
  | 'stand'
  | 'walk'
  | 'run'
  | 'march'
  | 'slide'
  | 'tap'
  | 'dangle'
  | 'tiptoe'
  | 'hidden';

export function drawBody(c: Ctx, led: string) {
  const x = BX;
  const y = BY;
  rect(c, x, y + 1, 40, 28, C.O);
  rect(c, x + 1, y, 38, 30, C.O);
  rect(c, x + 1, y + 1, 38, 28, C.BODY);
  rect(c, x + 2, y + 1, 36, 1, C.HI);
  rect(c, x + 1, y + 2, 1, 25, C.HI);
  rect(c, x + 38, y + 3, 1, 25, C.LO);
  rect(c, x + 2, y + 28, 36, 1, C.LO);
  for (const [a, b] of [
    [1, 1],
    [38, 1],
    [1, 28],
    [38, 28],
  ]) {
    rect(c, x + a, y + b, 1, 1, C.O);
  }
  rect(c, x + 3, y + 3, 34, 23, C.O);
  for (const a of [6, 8, 10]) {
    rect(c, x + a, y + 27, 1, 1, C.LO);
  }
  rect(c, x + 31, y + 27, 3, 1, led);
  rect(c, x + 15, y + 30, 10, 2, C.O);
  rect(c, x + 16, y + 30, 8, 2, C.LO);
  rect(c, x + 10, y + 32, 20, 3, C.O);
  rect(c, x + 11, y + 32, 18, 2, C.BODY);
  rect(c, x + 11, y + 32, 18, 1, C.HI);
}

const STEP_MS = { walk: 150, run: 80, march: 220 } as const;

export function drawFeet(c: Ctx, mode: FeetMode, t: number) {
  if (mode === 'hidden') {
    return;
  }
  const fy = BY + 35;
  let l = 0;
  let r = 0;
  let lx = 0;
  let rx = 0;
  if (mode === 'walk' || mode === 'run' || mode === 'march') {
    const ms = STEP_MS[mode];
    const lift = mode === 'march' ? 2 : 1;
    const phase = Math.floor(t / ms) % 4;
    l = phase === 0 ? -lift : 0;
    r = phase === 2 ? -lift : 0;
    lx = phase === 0 ? 1 : 0;
    rx = phase === 2 ? -1 : 0;
  } else if (mode === 'slide') {
    lx = toggle(t, 200) ? -1 : 1;
    rx = -lx;
  } else if (mode === 'tap') {
    r = toggle(t, 180) ? -1 : 0;
  } else if (mode === 'dangle') {
    const k = toggle(t, 160);
    l = 1;
    r = 1;
    lx = k ? -1 : 1;
    rx = k ? 1 : -1;
  } else if (mode === 'tiptoe') {
    l = -1;
    r = -1;
  }
  const foot = (x: number, dy: number) => {
    rect(c, x, fy + dy, 4, 2, C.O);
    rect(c, x + 1, fy + dy, 2, 1, C.LO);
  };
  foot(BX + 12 + lx, l);
  foot(BX + 24 + rx, r);
}

/** A hand at [x, y], optionally bent at an elbow, relative to the monitor's top-left corner. */
export type Hand =
  | readonly [number, number]
  | readonly [number, number, number, number]
  | readonly [number, number, number, number, 'thumb'];
export interface ArmPose {
  l?: Hand;
  r?: Hand;
}
type ArmFn = (t: number, p: number) => ArmPose;

const ROBOT: readonly ArmPose[] = [
  { l: [-5, 8, -5, 15], r: [46, 22, 46, 15] },
  { l: [-7, 22, -5, 15], r: [45, 8, 46, 15] },
  { l: [-5, 22], r: [44, 22] },
];
const cheer: ArmFn = (t) => ({ l: [-4, -2 + toggle(t, 200)], r: [43, -2 + toggle(t, 200)] });
const hug: ArmFn = () => ({ l: [26, 22, 6, 25], r: [13, 22, 33, 25] });
const hips: ArmFn = () => ({ l: [-1, 24, -5, 19], r: [40, 24, 44, 19] });
const scratch: ArmFn = (t) => ({ r: [36 + toggle(t, 120), -1, 44, 6] });

export const ARMS: Readonly<Record<string, ArmFn>> = {
  none: () => ({}),
  out: () => ({ l: [-5, 20], r: [44, 20] }),
  holdBoth: () => ({ l: [12, 29, 2, 23], r: [27, 29, 37, 23] }),
  wave: (t) => ({ r: [44 + toggle(t, 160) * 2, 2, 45, 10] }),
  waveL: (t) => ({ l: [-5 - toggle(t, 160) * 2, 2, -6, 10] }),
  waveBoth: (t) => ({
    l: [-5 - toggle(t, 160) * 2, 2, -6, 10],
    r: [44 + toggle(t, 160) * 2, 2, 45, 10],
  }),
  cheer,
  clap: (t) => ({
    l: [toggle(t, 130) ? 17 : 12, 27, 2, 23],
    r: [toggle(t, 130) ? 22 : 27, 27, 37, 23],
  }),
  shrug: () => ({ l: [-5, 9, -3, 16], r: [44, 9, 42, 16] }),
  pointL: () => ({ l: [-10, 15] }),
  pointR: () => ({ r: [49, 15] }),
  pointUp: () => ({ r: [44, -5] }),
  pointDown: () => ({ r: [46, 30] }),
  hips,
  facepalm: () => ({ r: [24, 9, 38, 18] }),
  scratch,
  stretch: () => ({ l: [2, -7], r: [37, -7] }),
  flex: (t) => ({ l: [-5, 6 - toggle(t, 300), -7, 14], r: [44, 6 - toggle(t, 300), 46, 14] }),
  hug,
  salute: () => ({ r: [33, 2, 44, 8] }),
  thumbs: () => ({ r: [45, 11, 44, 16, 'thumb'] }),
  thumbsBoth: () => ({ l: [-6, 11, -5, 16, 'thumb'], r: [45, 11, 44, 16, 'thumb'] }),
  rub: (t) => ({ l: [12 + toggle(t, 120), 13, 2, 20], r: [27 - toggle(t, 120), 13, 37, 20] }),
  cover: () => ({ l: [10, 10, 2, 18], r: [29, 10, 37, 18] }),
  conduct: (t) => ({
    r: [44 + Math.round(Math.cos(t / 220) * 3), 6 + Math.round(Math.sin(t / 220) * 4)],
  }),
  airguitar: (t) => ({ l: [6, 25 + toggle(t, 110), -2, 22], r: [45, 16] }),
  jazz: (t) => ({ l: [-7 + toggle(t, 90), 3], r: [46 - toggle(t, 90), 3] }),
  box: (t) => (toggle(t, 180) ? { l: [-11, 14], r: [43, 18] } : { l: [-4, 18], r: [50, 14] }),
  swim: (t) => ({
    l: [-4 + Math.round(Math.cos(t / 200) * 4), 12 + Math.round(Math.sin(t / 200) * 6)],
    r: [43 - Math.round(Math.cos(t / 200) * 4), 12 - Math.round(Math.sin(t / 200) * 6)],
  }),
  type: (t) => ({ l: [12, 29 - toggle(t, 100), 2, 24], r: [27, 28 + toggle(t, 100), 37, 24] }),
  drum: (t) => ({
    l: [12, toggle(t, 150) ? 24 : 28, 2, 22],
    r: [27, toggle(t, 150) ? 28 : 24, 37, 22],
  }),
  reach: (t) => ({ r: [43, -10 + toggle(t, 200)] }),
  reachBoth: (t) => ({ l: [-3, -9 + toggle(t, 200)], r: [42, -9 + toggle(t, 200)] }),
  disco: (t) => (toggle(t, 350) ? { r: [47, -3], l: [-4, 25] } : { l: [-7, -3], r: [44, 25] }),
  robot: (t) => ROBOT[Math.floor(t / 300) % ROBOT.length],
  tpose: () => ({ l: [-11, 15], r: [50, 15] }),
  flail: (t) => (toggle(t, 90) ? { l: [-7, 4], r: [46, 22] } : { l: [-7, 22], r: [46, 4] }),
  bow: () => ({ l: [4, 31], r: [35, 31] }),
  shield: () => ({ l: [10, 14, 2, 22], r: [29, 14, 37, 22] }),
  catch: () => ({ l: [6, 2, -2, 10], r: [33, 2, 41, 10] }),
  pray: () => ({ l: [19, 26, 4, 24], r: [20, 26, 35, 24] }),
  knock: (t) => ({ r: [36, 6 + toggle(t, 160) * 2, 44, 12] }),
  fan: (t) => ({ r: [36 + toggle(t, 100) * 3, 12, 44, 16] }),
  jacks: (t) => (toggle(t, 250) ? cheer(t, 0) : { l: [-3, 28], r: [42, 28] }),
  macarena: (t, p) =>
    [
      { r: [49, 15] as Hand },
      { l: [-10, 15] as Hand, r: [49, 15] as Hand },
      hug(t, p),
      scratch(t, p),
      hips(t, p),
    ][Math.floor(t / 450) % 5],
};

export function drawArm(c: Ctx, shoulderX: number, shoulderY: number, hand?: Hand) {
  if (!hand) {
    return null;
  }
  const hx = BX + hand[0];
  const hy = BY + hand[1];
  if (hand.length >= 4) {
    const ex = BX + (hand[2] as number);
    const ey = BY + (hand[3] as number);
    line(c, shoulderX, shoulderY, ex, ey, C.O);
    line(c, ex, ey, hx, hy, C.O);
  } else {
    line(c, shoulderX, shoulderY, hx, hy, C.O);
  }
  rect(c, hx - 1, hy - 1, 2, 2, C.O);
  if (hand[4] === 'thumb') {
    rect(c, hx - 1, hy - 3, 1, 2, C.O);
  }
  return [hx, hy] as const;
}

/** A body offset in grid pixels plus rotation (degrees) and scale. */
export interface PoseOffset {
  ox?: number;
  oy?: number;
  rot?: number;
  sx?: number;
  sy?: number;
}
type PoseFn = (t: number, p: number) => PoseOffset;

export const POSES: Readonly<Record<string, PoseFn>> = {
  tilt: () => ({ rot: -8 }),
  tiltR: () => ({ rot: 8 }),
  lean: () => ({ rot: 10 }),
  bounce: (t) => ({ oy: -Math.round(Math.abs(Math.sin(t / 130)) * 3) }),
  hop: (t) => ({ oy: -Math.round(Math.abs(Math.sin(t / 180)) * 6) }),
  jump: (_t, p) => ({
    oy: -Math.round(Math.sin(Math.PI * p) * 14),
    sy: p < 0.1 || p > 0.92 ? 0.9 : 1,
  }),
  spin: (t) => {
    const cos = Math.cos(t / 110);
    const sx =
      Math.abs(cos) < 0.25
        ? 0.2 * Math.sign(cos || 1)
        : (Math.sign(cos) * Math.round(Math.abs(cos) * 4)) / 4;
    return { sx };
  },
  flip: (_t, p) => ({
    rot: Math.round((p * 360) / 15) * 15,
    oy: -Math.round(Math.sin(Math.PI * p) * 12),
  }),
  shake: (t) => ({ ox: toggle(t, 50) ? 1 : -1 }),
  shiver: (t) => ({ ox: toggle(t, 30) }),
  sway: (t) => ({ rot: Math.round(Math.sin(t / 300) * 3) * 2 }),
  wiggle: (t) => ({ rot: Math.round(Math.sin(t / 90) * 2) * 3 }),
  squash: (t) => (toggle(t, 200) ? { sy: 0.9, sx: 1.08 } : { sy: 1.05, sx: 0.96 }),
  bow: () => ({ sy: 0.88, oy: 2 }),
  sit: () => ({ oy: 3 }),
  slump: () => ({ oy: 2, rot: -4 }),
  lie: () => ({ rot: -90, oy: -3 }),
  fall: (_t, p) => ({ rot: -Math.round(Math.min(1, p * 1.6) * 90) }),
  getup: (_t, p) => ({ rot: -Math.round((1 - p) * 90) }),
  float: (t) => ({ oy: -(6 + Math.round(Math.sin(t / 400) * 2)) }),
  dizzy: (t) => ({ rot: Math.round(Math.sin(t / 160) * 3) * 4 }),
  headbang: (t) => (toggle(t, 140) ? { sy: 0.92, rot: 4 } : {}),
  robot: (t) => ({ rot: [0, 6, 0, -6][Math.floor(t / 300) % 4] }),
  disco: (t) => (toggle(t, 350) ? { rot: 8, ox: 2 } : { rot: -8, ox: -2 }),
  twist: (t) => ({
    sx: [1, 0.9, 0.8, 0.9][Math.floor(t / 120) % 4],
    rot: Math.round(Math.sin(t / 120) * 2) * 3,
  }),
  tiptoe: () => ({ oy: -1 }),
  hide: (_t, p) => ({ oy: Math.round(Math.min(1, p * 2) * 40) }),
  hidden: () => ({ oy: 40 }),
  emerge: (_t, p) => ({ oy: Math.round((1 - easeOut(p)) * 40) }),
  stomp: (t) => (toggle(t, 250) ? { oy: -2 } : {}),
  nod: (t) => (toggle(t, 200) ? { sy: 0.94, oy: 1 } : {}),
  stretchUp: (_t, p) => ({
    sy: 1 + 0.12 * Math.sin(Math.PI * p),
    sx: 1 - 0.06 * Math.sin(Math.PI * p),
  }),
  sneeze: (_t, p) =>
    p < 0.7 ? { rot: -Math.round(p * 10), sy: 1 + p * 0.1 } : { rot: 12, ox: 3, sy: 0.9 },
  lookAround: (t) => ({ rot: [0, -6, 0, 6][Math.floor(t / 500) % 4] }),
  crouch: () => ({ sy: 0.86 }),
  collapse: (_t, p) => ({ sy: Math.max(0.04, 1 - p), sx: 1 + p * 0.3 }),
  expand: (_t, p) => ({ sy: Math.max(0.04, p), sx: 1.3 - p * 0.3 }),
  wobble: (t) => ({ rot: Math.round(Math.sin(t / 200) * 2) * 4 }),
};

const HEART = [
  '.##...##.',
  '####.####',
  '#########',
  '#########',
  '.#######.',
  '..#####..',
  '...###...',
  '....#....',
];

/** Screens that are part of Lia's own behavior (booting, sending, crashing). */
const BUILTIN: Readonly<Record<string, (c: Ctx, t: number, p: number, fs: FaceState) => void>> = {
  off: (c) => rect(c, 0, 0, SCREEN_W, SCREEN_H, C.BLACK),
  boot: (c, t, p, fs) => {
    rect(c, 0, 0, SCREEN_W, SCREEN_H, C.BLACK);
    if (p < 0.12) {
      if (toggle(t, 80)) {
        rect(c, 16, 10, 1, 1, C.W);
      }
    } else if (p < 0.3) {
      const w = Math.round(((p - 0.12) / 0.18) * 16);
      rect(c, 16 - w, 10, w * 2, 1, C.W);
    } else if (p < 0.42) {
      const h = Math.round(((p - 0.3) / 0.12) * 10);
      rect(c, 0, 10 - h, SCREEN_W, h * 2 + 1, '#cfeeff');
    } else {
      const level = Math.min(1, (p - 0.42) / 0.4);
      if (level >= 0.99) {
        drawFace(c, fs);
      } else {
        rect(c, 0, 0, SCREEN_W, SCREEN_H, C.SCREEN);
        drawBlob(c, level);
      }
    }
  },
  file: (c) => {
    rect(c, 0, 0, SCREEN_W, SCREEN_H, C.SCREEN);
    drawBlob(c, 0.35);
    rect(c, 10, 2, 12, 17, C.O);
    rect(c, 11, 3, 10, 15, C.W);
    rect(c, 18, 3, 3, 3, '#cfe0ea');
    rect(c, 18, 5, 3, 1, C.O);
    rect(c, 18, 3, 1, 3, C.O);
    rect(c, 13, 8, 6, 1, C.GLOW);
    rect(c, 13, 10, 6, 1, C.GLOW);
    rect(c, 13, 12, 4, 1, C.GLOW);
    rect(c, 13, 15, 1, 1, C.EYE);
    rect(c, 18, 15, 1, 1, C.EYE);
    rect(c, 15, 16, 2, 1, C.EYE);
  },
  loading: (c, _t, p) => {
    rect(c, 0, 0, SCREEN_W, SCREEN_H, C.SCREEN);
    rect(c, 4, 8, 24, 7, C.BLOB);
    rect(c, 5, 9, 22, 5, C.SCREEN);
    for (let i = 0; i < Math.min(7, Math.floor(p * 8)); i++) {
      rect(c, 6 + i * 3, 10, 2, 3, C.GLOW);
    }
  },
  heart: (c, t) => {
    rect(c, 0, 0, SCREEN_W, SCREEN_H, C.SCREEN);
    if (toggle(t, 280) === 0) {
      for (const [ox, oy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        sprite(c, HEART, 12 + ox, 6 + oy, { '#': C.HEART_HI });
      }
    }
    sprite(c, HEART, 12, 6, { '#': C.HEART });
    rect(c, 13, 7, 1, 1, C.W);
  },
  bsod: (c, t) => {
    rect(c, 0, 0, SCREEN_W, SCREEN_H, C.BSOD);
    rect(c, 4, 4, 2, 2, C.W);
    rect(c, 4, 8, 2, 2, C.W);
    rect(c, 10, 3, 2, 1, C.W);
    rect(c, 9, 4, 1, 6, C.W);
    rect(c, 10, 10, 2, 1, C.W);
    rect(c, 4, 14, 20, 1, '#bcd0ff');
    rect(c, 4, 16, 14, 1, '#bcd0ff');
    rect(c, 4, 18, Math.min(22, 4 + (Math.floor(t / 120) % 19)), 1, C.W);
  },
  glitch: (c, t, _p, fs) => {
    drawFace(c, { ...fs, face: 'startled' });
    const step = Math.floor(t / 70);
    for (let i = 0; i < 4; i++) {
      const y = Math.floor(hash(step * 7 + i) * 19);
      const dx = Math.floor(hash(step * 13 + i) * 7) - 3;
      /* Shorten the strip by its shift so it never spills onto the bezel. */
      const w = SCREEN_W - Math.abs(dx);
      c.drawImage(c.canvas, SX + Math.max(0, -dx), SY + y, w, 2, Math.max(0, dx), y, w, 2);
    }
    for (let i = 0; i < 12; i++) {
      rect(
        c,
        Math.floor(hash(step * 31 + i) * SCREEN_W),
        Math.floor(hash(step * 17 + i * 5) * SCREEN_H),
        1,
        1,
        i % 2 ? '#ff4fd8' : '#4ff0ff',
      );
    }
  },
  saver: (c, t) => {
    rect(c, 0, 0, SCREEN_W, SCREEN_H, C.BLACK);
    const tri = (v: number) => {
      const f = v % 2;
      return f < 1 ? f : 2 - f;
    };
    sprite(
      c,
      FEATHER_ROWS,
      Math.round(tri(t / 1700) * 24),
      Math.round(tri(t / 1150) * 14),
      FEATHER_PAL,
    );
  },
};

export const BUILTIN_SCREENS: ReadonlySet<string> = new Set(Object.keys(BUILTIN));

/** Draws the screen content in screen-local coordinates; `face` falls through to the face. */
export function drawScreen(c: Ctx, name: string, t: number, p: number, fs: FaceState) {
  const builtin = BUILTIN[name];
  if (builtin) {
    builtin(c, t, p, fs);
  } else {
    drawFace(c, fs);
  }
}
