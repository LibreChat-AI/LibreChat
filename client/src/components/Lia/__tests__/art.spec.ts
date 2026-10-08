import type { FaceState } from '../engine/face';
import {
  SX,
  SY,
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
  /* The face's glow blob is the one thing drawn as an image, from a cache painted with fillRect. */
  const image = c.drawImage.bind(c) as (...args: unknown[]) => void;
  c.drawImage = ((...args: unknown[]) => {
    const source = args[0] as { width: number; height: number };
    const at = args.slice(1).join(',');
    /* drawImage(image, dx, dy[, dw, dh]) or drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh). */
    const [x, y, w = source.width, h = source.height] = (
      args.length === 9 ? args.slice(5) : args.slice(1)
    ) as number[];
    rects.push({ key: `image:${source.width}x${source.height}@${at}`, x, y, w, h });
    image(...args);
  }) as CanvasRenderingContext2D['drawImage'];
  draw(c);
  return rects;
}

const signature = (face: string, extra: Partial<FaceState> = {}) =>
  paint((c) => drawFace(c, { ...BASE, face, ...extra }))
    .map((r) => r.key)
    .join('|');

/** Every direction Lia can look, including the diagonals. */
const GAZES = [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => [dx, dy] as const));

describe("Lia's pixel art", () => {
  it('gives every expression its own face', () => {
    const faces = EXPRESSIONS.map((e) => signature(e.key));
    expect(new Set(faces).size).toBe(EXPRESSIONS.length);
  });

  it('keeps every face inside the screen, even when looking around', () => {
    for (const e of EXPRESSIONS) {
      for (const [dx, dy] of GAZES) {
        for (const r of paint((c) => drawFace(c, { ...BASE, face: e.key, dx, dy }))) {
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(SCREEN_W);
          expect(r.y + r.h).toBeLessThanOrEqual(SCREEN_H);
        }
      }
    }
  });

  it('keeps every face inside the screen while its entrance plays', () => {
    for (const e of EXPRESSIONS) {
      for (let elapsed = 0; elapsed <= 600; elapsed += 15) {
        for (const r of paint((c) => drawFace(c, { ...BASE, face: e.key, elapsed }))) {
          expect(r.y).toBeGreaterThanOrEqual(0);
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

  it('draws every built-in screen as its own picture, distinct from the face', () => {
    const draw = (name: string, p: number) =>
      paint((c) => drawScreen(c, name, p * 2000, p, BASE))
        .map((r) => r.key)
        .join('|');
    const face = draw('face', 0.6);
    const screens = [...BUILTIN_SCREENS].map((name) => draw(name, 0.6));
    expect(new Set(screens).size).toBe(BUILTIN_SCREENS.size);
    expect(screens).not.toContain(face);
  });

  it("keeps the glitch screen's shifted strips inside the screen", () => {
    for (let t = 0; t < 7000; t += 70) {
      const canvas = document.createElement('canvas');
      const c = canvas.getContext('2d') as CanvasRenderingContext2D;
      const copies: number[][] = [];
      c.drawImage = ((...args: unknown[]) => {
        if (args.length === 9) {
          copies.push(args.slice(1) as number[]);
        }
      }) as CanvasRenderingContext2D['drawImage'];
      drawScreen(c, 'glitch', t, 0.5, BASE);
      for (const [sx, sy, sw, sh, x, y, w, h] of copies) {
        /* The source is read from the whole canvas, so it must lie on the screen at (SX, SY). */
        expect(sx).toBeGreaterThanOrEqual(SX);
        expect(sy).toBeGreaterThanOrEqual(SY);
        expect(sx + sw).toBeLessThanOrEqual(SX + SCREEN_W);
        expect(sy + sh).toBeLessThanOrEqual(SY + SCREEN_H);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + w).toBeLessThanOrEqual(SCREEN_W);
        expect(y + h).toBeLessThanOrEqual(SCREEN_H);
      }
    }
  });

  it('advances the progress screens as their step runs', () => {
    const draw = (name: string, p: number) =>
      paint((c) => drawScreen(c, name, p * 2000, p, BASE))
        .map((r) => r.key)
        .join('|');
    expect(draw('loading', 0.2)).not.toBe(draw('loading', 0.9));
    const boot = [0.2, 0.35, 0.6, 1].map((p) => draw('boot', p));
    expect(new Set(boot).size).toBe(boot.length);
    expect(draw('boot', 1).endsWith(draw('face', 0))).toBe(true);
  });

  it('ends the hide pose where the hidden and emerge poses take over', () => {
    expect(POSES.hide(1000, 1).oy).toBe(POSES.hidden(0, 0).oy);
    expect(POSES.emerge(0, 0).oy).toBe(POSES.hidden(0, 0).oy);
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
