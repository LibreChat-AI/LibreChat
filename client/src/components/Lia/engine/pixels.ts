/**
 * Lia's palette. These are brand art colors drawn into a canvas, like the pixels of a logo,
 * so they are fixed values rather than theme roles: Lia looks the same in every theme.
 */
export const C = {
  O: '#0f2a33',
  BODY: '#3b9ea3',
  HI: '#74d0cf',
  LO: '#2a7378',
  SCREEN: '#1f4f7c',
  DEEP: '#173d61',
  GLOW: '#8fcbe8',
  BLOB: '#f3f6e4',
  EYE: '#0b1218',
  W: '#ffffff',
  FEATHER: '#6cc4f0',
  FEATHER_HI: '#c8ecff',
  LED: '#f2a33a',
  PINK: '#ff7a93',
  HEART: '#ff5d7e',
  HEART_HI: '#ffc2cf',
  STAR: '#e9a21a',
  BSOD: '#2a56c6',
  BLACK: '#071018',
  TEAR: '#7fd0ff',
  MONEY: '#2f9e44',
  VEIN: '#e5484d',
} as const;

export type Ctx = CanvasRenderingContext2D;
export type Palette = Readonly<Record<string, string>>;
export type Rows = readonly string[];

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Ordered dithering: whether pixel (x, y) is lit at a coverage `level` from 0 to 1. */
export const dither = (x: number, y: number, level: number) =>
  (BAYER[y & 3][x & 3] + 0.5) / 16 < level;

export function rect(c: Ctx, x: number, y: number, w: number, h: number, color: string) {
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
}

/** Draws a sprite given as rows of characters; `.` is transparent, other characters index `pal`. */
export function sprite(c: Ctx, rows: Rows, x0: number, y0: number, pal: Palette, flip = false) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    const n = row.length;
    for (let x = 0; x < n; x++) {
      const color = pal[row[x]];
      if (color) {
        rect(c, x0 + (flip ? n - 1 - x : x), y0 + y, 1, 1, color);
      }
    }
  }
}

/** A one-pixel Bresenham line. */
export function line(c: Ctx, ax: number, ay: number, bx: number, by: number, color: string) {
  let x0 = Math.round(ax);
  let y0 = Math.round(ay);
  const x1 = Math.round(bx);
  const y1 = Math.round(by);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let i = 0; i < 400; i++) {
    rect(c, x0, y0, 1, 1, color);
    if (x0 === x1 && y0 === y1) {
      return;
    }
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Deterministic pseudo-random value in [0, 1) for an integer seed. */
export function hash(n: number) {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
/** Two-state square wave: 0 or 1, switching every `ms`. */
export const toggle = (t: number, ms: number) => Math.floor(t / ms) % 2;
