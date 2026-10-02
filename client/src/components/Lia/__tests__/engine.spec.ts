import type { Bubble } from '../engine/types';
import { ACTION_BY_ID } from '../engine/catalog';
import { LiaEngine } from '../engine/engine';

const PLATFORM = { y: 400, x0: 100, x1: 700 };

function setup() {
  const bubbles: Array<Bubble | null> = [];
  const canvas = document.createElement('canvas');
  const engine = new LiaEngine(
    canvas,
    { platform: () => PLATFORM, onBubble: (b) => bubbles.push(b) },
    0,
  );
  return { engine, bubbles, canvas };
}

/** Advances the engine frame by frame, the way requestAnimationFrame would. */
function run(engine: LiaEngine, from: number, to: number) {
  for (let t = from; t <= to; t += 16) {
    engine.tick(t);
  }
}

/** A seeded generator, so choices are repeatable. */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function bigShare(engine: LiaEngine, now: number) {
  const random = seeded();
  let big = 0;
  for (let i = 0; i < 400; i++) {
    const def = ACTION_BY_ID.get(engine.chooseLife(now, random) ?? '');
    if (def && (def.moves || def.cat === 'life' || def.cat === 'dance' || def.cat === 'travel')) {
      big += 1;
    }
  }
  return big / 400;
}

describe('LiaEngine', () => {
  it('plays an action through its steps and then finishes', () => {
    const { engine } = setup();
    engine.life = false;
    expect(engine.play('intro', 4, 0)).toBe(true);
    expect(engine.current?.id).toBe('intro');
    run(engine, 0, 4000);
    expect(engine.current).toBeNull();
  });

  it('keeps a more important action from being interrupted', () => {
    const { engine } = setup();
    engine.play('r-crash', 3, 0);
    expect(engine.play('feel-happy', 1, 10)).toBe(false);
    expect(engine.current?.id).toBe('r-crash');
  });

  it('stays quiet while the user types and saves big routines for when they step away', () => {
    const { engine } = setup();
    engine.noteTyping(1000);
    expect(engine.chooseLife(1000)).toBeNull();

    engine.noteActivity(false, 10_000);
    const present = bigShare(engine, 10_000);
    const idle = bigShare(engine, 60_000);
    expect(present).toBeLessThan(0.25);
    expect(idle).toBeGreaterThan(0.5);
  });

  it('stops a big routine as soon as the user starts typing', () => {
    const { engine } = setup();
    engine.play('travel-walk', 1, 0);
    engine.noteTyping(100);
    expect(engine.current).toBeNull();
  });

  it('never picks moving actions under reduced motion', () => {
    const { engine } = setup();
    engine.reducedMotion = true;
    const random = seeded(3);
    for (let i = 0; i < 300; i++) {
      const def = ACTION_BY_ID.get(engine.chooseLife(60_000, random) ?? '');
      expect(def?.moves ?? false).toBe(false);
    }
  });

  it('escalates from petting to dizziness to a crash', () => {
    const { engine } = setup();
    engine.pet(0);
    expect(engine.current?.id).toMatch(/^r-pet-/);
    for (let i = 1; i < 5; i++) {
      engine.pet(i * 100);
    }
    expect(engine.current?.id).toBe('r-dizzy');
    for (let i = 5; i < 8; i++) {
      engine.pet(i * 100);
    }
    expect(engine.current?.id).toBe('r-crash');
  });

  it('wakes from a nap only on a deliberate action', () => {
    const { engine } = setup();
    engine.play('nap', 1, 0);
    engine.noteActivity(false, 100);
    expect(engine.current?.id).toBe('nap');
    engine.noteActivity(true, 200);
    expect(engine.current?.id).toBe('r-wake');
  });

  it('wakes from a nap on a click without turning it into a pet', () => {
    const { engine } = setup();
    engine.play('nap', 1, 0);
    engine.pet(100);
    expect(engine.current?.id).toBe('r-wake');
  });

  it('runs a single animation loop however often it is started', () => {
    const { engine } = setup();
    const raf = jest.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 7);
    const cancel = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    engine.start();
    engine.start();
    expect(raf).toHaveBeenCalledTimes(1);
    engine.stop();
    expect(cancel).toHaveBeenCalledWith(7);
    engine.start();
    expect(raf).toHaveBeenCalledTimes(2);
  });

  it('stays stopped when a host callback stops it mid-frame', () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const canvas = document.createElement('canvas');
    const engine: LiaEngine = new LiaEngine(
      canvas,
      { platform: () => PLATFORM, onBubble: () => undefined, onFrame: () => engine.stop() },
      0,
    );
    engine.start();
    frames[0](16);
    expect(frames).toHaveLength(1);
  });

  it('finishes a walk at once when reduced motion turns on', () => {
    const { engine } = setup();
    engine.life = false;
    engine.play('travel-walk', 2, 0);
    run(engine, 0, 200);
    engine.reducedMotion = true;
    const at = engine.position.x;
    run(engine, 200, 1200);
    expect(engine.position.x).toBe(at);
    expect(engine.current?.id).not.toBe('travel-walk');
  });

  it('reports speech bubbles to the host and clears them', () => {
    const { engine, bubbles } = setup();
    engine.life = false;
    engine.play('r-hello', 2, 0);
    run(engine, 0, 2500);
    expect(bubbles).toContainEqual({ say: 'hi' });
    expect(bubbles[bubbles.length - 1]).toBeNull();
  });

  it('positions the canvas on the platform', () => {
    const { engine, canvas } = setup();
    engine.life = false;
    run(engine, 0, 100);
    expect(engine.position.y).toBe(PLATFORM.y);
    expect(engine.position.x).toBeGreaterThanOrEqual(PLATFORM.x0);
    expect(engine.position.x).toBeLessThanOrEqual(PLATFORM.x1);
    expect(canvas.style.transform).toMatch(/^translate\(/);
  });
});
