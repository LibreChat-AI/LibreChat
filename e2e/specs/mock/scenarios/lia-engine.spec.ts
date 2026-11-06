import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type * as Catalog from '../../../../client/src/components/Lia/engine/catalog';
import type * as Engine from '../../../../client/src/components/Lia/engine/engine';
import { openLiaEngine } from '../lia.helpers';

/**
 * Lia's behavior engine, running on real animation frames and a real canvas. Nothing mounts it
 * yet, so each test serves the engine modules to a blank page and drives it as a host would.
 */
type Lia = { engine: typeof Engine; catalog: typeof Catalog };

const openEngine = (page: Page) => openLiaEngine(page, ['engine', 'catalog']);

test.describe("Lia's behavior engine", () => {
  test('Lia stays quiet while the user types and saves big routines for when they step away @scenario:lia-engine-attention-budget', async ({
    page,
  }) => {
    await openEngine(page);
    const result = await page.evaluate(async () => {
      const { engine: mod, catalog } = (window as unknown as { lia: Lia }).lia;
      const canvas = document.createElement('canvas');
      document.body.appendChild(canvas);
      const engine = new mod.LiaEngine(canvas, {
        platform: () => ({ y: 200, x0: 100, x1: 700 }),
        onBubble: () => undefined,
      });
      engine.life = false;
      engine.start();
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      for (let i = 0; i < 10; i++) {
        await frame();
      }
      const pixels = (canvas.getContext('2d') as CanvasRenderingContext2D)
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((v, i) => i % 4 === 3 && v > 0);

      engine.play('travel-walk', 1);
      await frame();
      engine.noteTyping();
      const afterTyping = engine.current?.id ?? null;
      const choiceWhileTyping = engine.chooseLife();

      engine.play('nap', 1);
      engine.noteTyping();
      const napAfterTyping = engine.current?.id ?? null;
      engine.stop();

      let s = 7;
      const random = () => {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
      };
      const bigShare = (now: number) => {
        let big = 0;
        for (let i = 0; i < 400; i++) {
          const def = catalog.ACTION_BY_ID.get(engine.chooseLife(now, random) ?? '');
          if (def && (def.moves || ['life', 'dance', 'travel'].includes(def.cat))) {
            big += 1;
          }
        }
        return big / 400;
      };
      const base = performance.now() + 10_000;
      engine.noteActivity(false, base);
      return {
        pixels,
        afterTyping,
        choiceWhileTyping,
        napAfterTyping,
        present: bigShare(base),
        away: bigShare(base + 60_000),
      };
    });
    expect(result.pixels).toBe(true);
    expect(result.afterTyping).toBeNull();
    expect(result.choiceWhileTyping).toBeNull();
    expect(result.napAfterTyping).toBe('r-wake');
    expect(result.present).toBeLessThan(0.25);
    expect(result.away).toBeGreaterThan(0.5);
  });

  test('Lia never walks under reduced motion @scenario:lia-engine-reduced-motion', async ({
    page,
  }) => {
    await openEngine(page);
    const result = await page.evaluate(async () => {
      const { engine: mod, catalog } = (window as unknown as { lia: Lia }).lia;
      const engine = new mod.LiaEngine(document.createElement('canvas'), {
        platform: () => ({ y: 200, x0: 100, x1: 700 }),
        onBubble: () => undefined,
      });
      engine.life = false;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      engine.start();
      await wait(100);
      const before = engine.position.x;
      engine.play('travel-run', 2);
      await wait(150);
      engine.reducedMotion = true;
      const snapped = engine.position.x;
      await wait(500);
      const settled = engine.position.x;
      engine.stop();

      const moving: string[] = [];
      for (let i = 0; i < 400; i++) {
        const id = engine.chooseLife(performance.now() + 120_000);
        if (id && catalog.ACTION_BY_ID.get(id)?.moves) {
          moving.push(id);
        }
      }
      return { before, snapped, settled, moving };
    });
    expect(result.snapped).not.toBe(result.before);
    expect(result.settled).toBe(result.snapped);
    expect(result.moving).toEqual([]);
  });
});
