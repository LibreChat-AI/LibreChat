import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type * as Body from '../../../../client/src/components/Lia/engine/body';
import type * as Face from '../../../../client/src/components/Lia/engine/face';
import { openLiaEngine } from '../lia.helpers';

/**
 * Lia's pixel art, drawn by a real browser canvas. Nothing mounts the renderer yet, so each
 * test serves the engine modules to a blank page and reads back the pixels they paint.
 */
type Lia = { face: typeof Face; body: typeof Body };

const openEngine = (page: Page) => openLiaEngine(page, ['face', 'body']);

test.describe("Lia's pixel art", () => {
  test('every expression draws its own face @scenario:lia-art-distinct-faces', async ({ page }) => {
    await openEngine(page);
    const { count, distinct } = await page.evaluate(() => {
      const { face } = (window as unknown as { lia: Lia }).lia;
      const images = face.EXPRESSIONS.map((e) => {
        const canvas = document.createElement('canvas');
        canvas.width = face.SCREEN_W;
        canvas.height = face.SCREEN_H;
        const c = canvas.getContext('2d') as CanvasRenderingContext2D;
        face.drawFace(c, {
          face: e.key,
          elapsed: 2000,
          dx: 0,
          dy: 0,
          feather: true,
          t: 1000,
          blink: false,
        });
        return canvas.toDataURL();
      });
      return { count: images.length, distinct: new Set(images).size };
    });
    expect(count).toBeGreaterThan(50);
    expect(distinct).toBe(count);
  });

  test('Lia paints only inside her canvas and her screen @scenario:lia-art-stays-in-bounds', async ({
    page,
  }) => {
    await openEngine(page);
    const strays = await page.evaluate(() => {
      const { face, body } = (window as unknown as { lia: Lia }).lia;
      const found: string[] = [];
      /** Draws on a canvas with a margin around the box, and names any pixel painted outside it. */
      const check = (
        label: string,
        w: number,
        h: number,
        draw: (c: CanvasRenderingContext2D) => void,
      ) => {
        const pad = 16;
        const canvas = document.createElement('canvas');
        canvas.width = w + pad * 2;
        canvas.height = h + pad * 2;
        const c = canvas.getContext('2d') as CanvasRenderingContext2D;
        c.translate(pad, pad);
        draw(c);
        const { data } = c.getImageData(0, 0, canvas.width, canvas.height);
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const inside = x >= pad && x < pad + w && y >= pad && y < pad + h;
            if (!inside && data[(y * canvas.width + x) * 4 + 3] > 0) {
              found.push(`${label} at ${x - pad},${y - pad}`);
              return;
            }
          }
        }
      };
      for (const e of face.EXPRESSIONS) {
        /* Every direction Lia can look, including the diagonals. */
        for (const [dx, dy] of [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y) => [x, y]))) {
          /* From the first frame of the entrance (sunglasses dropping in) to long after. */
          for (const elapsed of [0, 30, 200, 2000]) {
            check(`face ${e.key} at ${elapsed}ms`, face.SCREEN_W, face.SCREEN_H, (c) =>
              face.drawFace(c, {
                face: e.key,
                elapsed,
                dx,
                dy,
                feather: true,
                t: 1000,
                blink: false,
              }),
            );
          }
        }
      }
      check('body, feet and arms', body.GRID_W, body.GRID_H, (c) => {
        body.drawBody(c, '#000');
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
            body.drawFeet(c, mode, t);
          }
        }
        for (const fn of Object.values(body.ARMS)) {
          for (const t of [0, 120, 250, 500, 1000]) {
            const pose = fn(t, 0.5);
            body.drawArm(c, 11, 35, pose.l);
            body.drawArm(c, 52, 35, pose.r);
          }
        }
      });
      /* Screens draw over the monitor in place, so compare against the bare body: every pixel a
       * screen changes must lie on the screen. The glitch screen copies strips of the canvas. */
      const grid = () => {
        const canvas = document.createElement('canvas');
        canvas.width = body.GRID_W;
        canvas.height = body.GRID_H;
        const c = canvas.getContext('2d') as CanvasRenderingContext2D;
        body.drawBody(c, '#000');
        return c;
      };
      const bare = grid().getImageData(0, 0, body.GRID_W, body.GRID_H).data;
      const state = {
        face: 'neutral',
        elapsed: 2000,
        dx: 0,
        dy: 0,
        feather: true,
        t: 1000,
        blink: false,
      };
      for (const name of body.BUILTIN_SCREENS) {
        for (let t = 0; t < 3000; t += 70) {
          const c = grid();
          c.save();
          c.translate(body.SX, body.SY);
          body.drawScreen(c, name, t, (t % 1000) / 1000, state);
          c.restore();
          const { data } = c.getImageData(0, 0, body.GRID_W, body.GRID_H);
          for (let i = 0; i < data.length; i += 4) {
            const x = (i / 4) % body.GRID_W;
            const y = Math.floor(i / 4 / body.GRID_W);
            const onScreen =
              x >= body.SX &&
              x < body.SX + face.SCREEN_W &&
              y >= body.SY &&
              y < body.SY + face.SCREEN_H;
            const changed = [0, 1, 2, 3].some((k) => data[i + k] !== bare[i + k]);
            if (changed && !onScreen) {
              found.push(`screen ${name} at ${x},${y} (t=${t})`);
              break;
            }
          }
        }
      }
      return found;
    });
    expect(strays).toEqual([]);
  });
});
