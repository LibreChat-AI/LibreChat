import type { Bubble } from '../engine/types';
import { ACTION_BY_ID } from '../engine/catalog';
import { LiaEngine } from '../engine/engine';
import * as body from '../engine/body';

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
    let chosen = 0;
    for (let i = 0; i < 300; i++) {
      const id = engine.chooseLife(60_000, random);
      if (id == null) {
        continue;
      }
      const def = ACTION_BY_ID.get(id);
      expect(def).toBeDefined();
      expect(def?.moves).toBe(false);
      chosen += 1;
    }
    expect(chosen).toBeGreaterThan(0);
  });

  it('is not busy before the user has typed', () => {
    const { engine } = setup();
    expect(engine.attention(100)).not.toBe('busy');
    expect(engine.chooseLife(100, seeded())).not.toBeNull();
  });

  it('only walks to the pointer once there is one', () => {
    const { engine } = setup();
    const toPointer = (id: string | null) =>
      ACTION_BY_ID.get(id ?? '')?.steps.some(([, spec]) => spec.m?.to === 'pointer') ?? false;
    const picks = (seed: number) => {
      const random = seeded(seed);
      return Array.from({ length: 2000 }, () => engine.chooseLife(60_000, random));
    };
    expect(picks(5).some(toPointer)).toBe(false);
    engine.pointer = { x: 300, y: 380 };
    expect(picks(5).some(toPointer)).toBe(true);
  });

  it('holds a step while there is no layout and plays it once Lia is visible', () => {
    let platform: typeof PLATFORM | null = null;
    const engine = new LiaEngine(
      document.createElement('canvas'),
      { platform: () => platform, onBubble: () => undefined },
      0,
    );
    engine.life = false;
    engine.play('feel-happy', 2, 0);
    run(engine, 0, 3000);
    platform = PLATFORM;
    /* Its first step lasts at least 1.5 s; a clock that kept running would end it at once. */
    run(engine, 3016, 4000);
    expect(engine.current?.id).toBe('feel-happy');
  });

  it('resumes the screen where it was after layout comes back', () => {
    const progress: number[] = [];
    const draw = jest.spyOn(body, 'drawScreen');
    draw.mockImplementation((_c, name, _t, p) => {
      if (name === 'boot') {
        progress.push(p);
      }
    });
    let platform: typeof PLATFORM | null = PLATFORM;
    const engine = new LiaEngine(
      document.createElement('canvas'),
      { platform: () => platform, onBubble: () => undefined },
      0,
    );
    engine.life = false;
    engine.play('intro', 4, 0);
    run(engine, 0, 1104);
    const before = progress[progress.length - 1];
    platform = null;
    run(engine, 1120, 5000);
    platform = PLATFORM;
    run(engine, 5008, 5008);
    draw.mockRestore();
    expect(before).toBeLessThan(0.2);
    expect(progress[progress.length - 1]).toBeLessThan(0.2);
  });

  it('keeps a glance that started before layout went away', () => {
    const faces: string[] = [];
    const draw = jest.spyOn(body, 'drawScreen');
    draw.mockImplementation((_c, _name, _t, _p, fs) => {
      faces.push(fs.face);
    });
    let platform: typeof PLATFORM | null = PLATFORM;
    const engine = new LiaEngine(
      document.createElement('canvas'),
      { platform: () => platform, onBubble: () => undefined },
      0,
    );
    engine.life = false;
    run(engine, 0, 96);
    engine.glance('surprised', 400, undefined, engine.clock(96));
    run(engine, 112, 160);
    platform = null;
    run(engine, 176, 3000);
    platform = PLATFORM;
    run(engine, 3008, 3008);
    draw.mockRestore();
    expect(faces[faces.length - 1]).toBe('surprised');
  });

  it('replaces an action without reporting a gap the host could fill', () => {
    const labels: Array<string | null> = [];
    const engine: LiaEngine = new LiaEngine(
      document.createElement('canvas'),
      {
        platform: () => PLATFORM,
        onBubble: () => undefined,
        onAction: (label) => {
          labels.push(label);
          if (label == null) {
            engine.play('r-crash', 3, 0);
          }
        },
      },
      0,
    );
    engine.life = false;
    engine.play('intro', 4, 0);
    engine.play('feel-happy', 4, 0);
    expect(labels).toEqual([
      ACTION_BY_ID.get('intro')?.label,
      ACTION_BY_ID.get('feel-happy')?.label,
    ]);
    expect(engine.current?.id).toBe('feel-happy');
  });

  it('walks an action the host starts when the previous one ends', () => {
    let chained = false;
    let clock = 0;
    const engine: LiaEngine = new LiaEngine(
      document.createElement('canvas'),
      {
        platform: () => PLATFORM,
        onBubble: () => undefined,
        onAction: (label) => {
          if (label == null && !chained) {
            chained = true;
            engine.play('sit-edge', 2, clock);
          }
        },
      },
      0,
    );
    engine.life = false;
    engine.play('feel-happy', 2, 0);
    for (; clock <= 8000; clock += 16) {
      engine.tick(clock);
    }
    expect(chained).toBe(true);
    /* The walk reaches the edge well before the nine-second move timeout would snap it there. */
    expect(engine.position.x).toBe(PLATFORM.x1);
  });

  it('wakes from a nap the host played at a high priority', () => {
    const { engine } = setup();
    engine.life = false;
    engine.play('nap', 4, 0);
    engine.noteTyping(100);
    expect(engine.current?.id).toBe('r-wake');
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

  it('wakes from a nap when the user starts typing', () => {
    const { engine } = setup();
    engine.play('nap', 1, 0);
    engine.noteTyping(100);
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

  it('keeps one animation loop when a host callback restarts the engine mid-frame', () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    let restart = true;
    const engine: LiaEngine = new LiaEngine(
      document.createElement('canvas'),
      {
        platform: () => PLATFORM,
        onBubble: () => undefined,
        onFrame: () => {
          if (restart) {
            restart = false;
            engine.stop();
            engine.start();
          }
        },
      },
      0,
    );
    engine.start();
    frames[0](16);
    /* The first frame scheduled only the restarted loop, not a second copy of its own. */
    expect(frames).toHaveLength(2);
    frames[1](32);
    expect(frames).toHaveLength(3);
  });

  it('plays every step of an action the host starts from onAction', () => {
    let chained = false;
    const engine: LiaEngine = new LiaEngine(
      document.createElement('canvas'),
      {
        platform: () => PLATFORM,
        onBubble: () => undefined,
        onAction: (label) => {
          if (label && !chained) {
            chained = true;
            engine.play('feel-happy', 4, 0);
          }
        },
      },
      0,
    );
    engine.life = false;
    engine.play('intro', 4, 0);
    expect(engine.current?.id).toBe('feel-happy');
    /* Its first step lasts at least 1.5 s; skipping it would end the action within 0.3 s. */
    run(engine, 0, 1000);
    expect(engine.current?.id).toBe('feel-happy');
  });

  it('does the first move of a reduced-motion action where it snapped, before any frame', () => {
    const { engine } = setup();
    engine.life = false;
    engine.reducedMotion = true;
    engine.play('sit-edge', 2, 0);
    expect(engine.position.x).toBe(PLATFORM.x1);
    run(engine, 0, 100);
    expect(engine.position.x).toBe(PLATFORM.x1);
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

  it('finishes a walk at the platform edge when the platform shrinks under it', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.99);
    const platform = { ...PLATFORM };
    const engine = new LiaEngine(
      document.createElement('canvas'),
      { platform: () => platform, onBubble: () => undefined },
      0,
    );
    engine.life = false;
    engine.play('travel-walk', 2, 0);
    run(engine, 0, 200);
    platform.x1 = 300;
    run(engine, 200, 1200);
    expect(engine.position.x).toBe(300);
    expect(engine.current).toBeNull();
  });

  it('walks once the page has a layout when an action starts before it', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.99);
    let ready = false;
    const engine = new LiaEngine(
      document.createElement('canvas'),
      { platform: () => (ready ? PLATFORM : null), onBubble: () => undefined },
      0,
    );
    engine.life = false;
    engine.play('travel-walk', 2, 0);
    run(engine, 0, 100);
    ready = true;
    run(engine, 100, 400);
    const start = engine.position.x;
    run(engine, 400, 6000);
    expect(engine.position.x).toBeGreaterThan(start);
    expect(engine.position.x).toBeCloseTo(PLATFORM.x0 + 0.99 * (PLATFORM.x1 - PLATFORM.x0));
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
