import type { FaceState } from '../engine/face';
import {
  ARMS,
  POSES,
  GRID_W,
  GRID_H,
  drawArm,
  drawBody,
  drawFeet,
  drawScreen,
  BUILTIN_SCREENS,
} from '../engine/body';
import { drawFace, EXPRESSIONS, SCREEN_W, SCREEN_H } from '../engine/face';

const BASE: FaceState = {
  face: 'neutral',
  elapsed: 2000,
  dx: 0,
  dy: 0,
  feather: true,
  t: 1000,
  blink: false,
};

/** Records every pixel rectangle a drawing call paints, as `color:x,y,w,h`. */
function paint(draw: (c: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  const c = canvas.getContext('2d') as CanvasRenderingContext2D;
  const rects: Array<{ key: string; x: number; y: number; w: number; h: number }> = [];
  const fill = c.fillRect.bind(c);
  c.fillRect = (x: number, y: number, w: number, h: number) => {
    rects.push({ key: `${String(c.fillStyle)}:${x},${y},${w},${h}`, x, y, w, h });
    fill(x, y, w, h);
  };
  draw(c);
  return rects;
}

const signature = (face: string, extra: Partial<FaceState> = {}) =>
  paint((c) => drawFace(c, { ...BASE, face, ...extra }))
    .map((r) => r.key)
    .join('|');

describe("Lia's pixel art", () => {
  it('gives every expression its own face', () => {
    const faces = EXPRESSIONS.map((e) => signature(e.key));
    expect(new Set(faces).size).toBe(EXPRESSIONS.length);
  });

  it('keeps every face inside the screen, even when looking around', () => {
    for (const e of EXPRESSIONS) {
      for (const [dx, dy] of [
        [-1, -1],
        [1, 1],
      ]) {
        for (const r of paint((c) => drawFace(c, { ...BASE, face: e.key, dx, dy }))) {
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(SCREEN_W);
          expect(r.y + r.h).toBeLessThanOrEqual(SCREEN_H);
        }
      }
    }
  });

  it('closes open eyes when blinking and leaves closed ones alone', () => {
    expect(signature('neutral', { blink: true })).not.toBe(signature('neutral'));
    expect(signature('happy', { blink: true })).toBe(signature('happy'));
  });

  it('drops the sunglasses in over the first moments of the expression', () => {
    expect(signature('cool', { elapsed: 0 })).not.toBe(signature('cool', { elapsed: 2000 }));
  });

  it('keeps the body, feet and every arm pose inside the canvas', () => {
    const rects = paint((c) => {
      drawBody(c, '#000');
      for (const mode of [
        'stand',
        'walk',
        'run',
        'march',
        'slide',
        'tap',
        'dangle',
        'tiptoe',
      ] as const) {
        for (const t of [0, 150, 300, 450]) {
          drawFeet(c, mode, t);
        }
      }
      for (const fn of Object.values(ARMS)) {
        for (const t of [0, 120, 250, 500, 1000]) {
          const pose = fn(t, 0.5);
          drawArm(c, 11, 35, pose.l);
          drawArm(c, 52, 35, pose.r);
        }
      }
    });
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(GRID_W);
      expect(r.y + r.h).toBeLessThanOrEqual(GRID_H);
    }
  });

  it('draws every built-in screen across its whole run', () => {
    for (const name of BUILTIN_SCREENS) {
      for (const p of [0, 0.2, 0.35, 0.5, 1]) {
        expect(paint((c) => drawScreen(c, name, p * 2000, p, BASE)).length).toBeGreaterThan(0);
      }
    }
  });

  it('describes every pose as a small offset', () => {
    for (const fn of Object.values(POSES)) {
      for (const p of [0, 0.5, 1]) {
        const v = fn(p * 1000, p);
        expect(Math.abs(v.ox ?? 0)).toBeLessThanOrEqual(4);
        expect(Math.abs(v.oy ?? 0)).toBeLessThanOrEqual(40);
      }
    }
  });
});
