import type {
  Duration,
  ActionDef,
  Bubble,
  LabelKey,
  Category,
  Channels,
  Look,
  MoveStyle,
  MoveTarget,
  Platform,
  Point,
  StepSpec,
} from './types';
import type { FeetMode, PoseOffset } from './body';
import {
  BX,
  BY,
  SX,
  SY,
  ARMS,
  POSES,
  GRID_W,
  GRID_H,
  FOOT_Y,
  HEAD_ROWS,
  drawArm,
  drawBody,
  drawFeet,
  drawScreen,
} from './body';
import { SCREEN_W, SCREEN_H, EXPRESSION_BY_KEY } from './face';
import { ACTIONS, ACTION_BY_ID, PET_COUNT } from './catalog';
import { C, rect, clamp, toggle } from './pixels';

/** What the engine needs from the page around it. */
export interface LiaHost {
  /** The surface Lia stands on, or null while the page has no layout yet. */
  platform(): Platform | null;
  /** Called when the speech bubble changes. */
  onBubble(bubble: Bubble | null): void;
  /** Called when Lia starts or stops an action, with its label key. */
  onAction?(label: LabelKey | null): void;
  /** Called every frame with the point above Lia's head, for positioning the bubble. */
  onFrame?(head: Point): void;
}

export type Attention = 'busy' | 'present' | 'idle';

interface MoveStyleSpec {
  speed: number;
  feet: FeetMode;
  bob?: number;
  hop?: number;
  tilt?: number;
  pose?: string;
}

const STYLES: Readonly<Record<MoveStyle, MoveStyleSpec>> = {
  walk: { speed: 22, feet: 'walk', bob: 1 },
  tiptoe: { speed: 10, feet: 'tiptoe', pose: 'tiptoe' },
  run: { speed: 70, feet: 'run', bob: 1, tilt: 8 },
  hop: { speed: 36, feet: 'stand', hop: 7 },
  moonwalk: { speed: 16, feet: 'slide', tilt: -6 },
  skip: { speed: 30, feet: 'walk', hop: 4 },
  sneak: { speed: 11, feet: 'walk', pose: 'crouch' },
  march: { speed: 18, feet: 'march', bob: 1 },
  slide: { speed: 46, feet: 'stand', tilt: 6 },
  wobble: { speed: 16, feet: 'walk', pose: 'wobble' },
  shuffle: { speed: 8, feet: 'slide' },
  dash: { speed: 150, feet: 'run', tilt: 12 },
  teleport: { speed: 0, feet: 'stand' },
};

/** How strongly each kind of activity is preferred when Lia picks for herself. */
const CATEGORY_WEIGHT: Readonly<Partial<Record<Category, number>>> = {
  life: 30,
  emote: 10,
  say: 7,
  gesture: 8,
  dance: 6,
  travel: 12,
};
const BIG: ReadonlySet<Category> = new Set(['life', 'dance', 'travel']);
/** A step that waits for a move gives up and snaps after this long, so a slow style never drags. */
const MOVE_TIMEOUT_MS = 9000;
const TYPING_QUIET_MS = 2500;
const PRESENT_MS = 12000;

interface Run {
  def: ActionDef;
  prio: number;
  index: number;
  ch: Channels;
  stepStart: number;
  stepDur: number;
  waitMove: boolean;
  moved: boolean;
  poseStart: number;
}

interface Overlay extends Channels {
  start: number;
  until: number;
}

interface Move {
  tx: number;
  style: MoveStyle;
  start: number;
  done: () => void;
}

export class LiaEngine {
  /** Screen pixels per grid pixel. */
  scale = 2;
  reducedMotion = false;
  /** Whether Lia chooses activities on her own. */
  life = true;
  pointer: Point | null = null;
  caret: Point | null = null;
  readonly mood = { energy: 0.85, joy: 0.6 };

  private gx = 0;
  private gy = 0;
  private placed = false;
  private move: Move | null = null;
  private landAt = -1e9;
  private pose: Required<PoseOffset> = { ox: 0, oy: 0, rot: 0, sx: 1, sy: 1 };
  private run: Run | null = null;
  private overlay: Overlay | null = null;
  private nextLifeAt = 0;
  private recent: string[] = [];
  private screen = { name: 'face', start: 0, dur: 1000 };
  private expression = { name: 'neutral', start: 0 };
  private blinkUntil = 0;
  private nextBlink = 0;
  private lastDraw = 0;
  private lastFrame = 0;
  private bubble: Bubble | null = null;
  private typingUntil = 0;
  private lastUser = 0;
  private clicks: number[] = [];
  private petIndex = 0;
  private frameId = 0;
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: LiaHost,
    now = performance.now(),
  ) {
    canvas.width = GRID_W;
    canvas.height = GRID_H;
    this.ctx = canvas.getContext('2d');
    this.lastUser = now;
    this.lastFrame = now;
  }

  start() {
    const loop = (now: number) => {
      this.tick(now);
      this.frameId = requestAnimationFrame(loop);
    };
    this.frameId = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.frameId);
  }

  /** The action playing now, if any. */
  get current(): ActionDef | null {
    return this.run?.def ?? null;
  }

  get position(): Point {
    return { x: this.gx, y: this.gy };
  }

  attention(now = performance.now()): Attention {
    if (now < this.typingUntil + TYPING_QUIET_MS) {
      return 'busy';
    }
    if (now - this.lastUser < PRESENT_MS) {
      return 'present';
    }
    return 'idle';
  }

  /**
   * Something the user did on the page; keeps Lia's bigger routines for when they step away.
   * A `deliberate` action (a click, typing, a drop) also wakes Lia from a nap.
   */
  noteActivity(deliberate = false, now = performance.now()) {
    this.lastUser = now;
    if (deliberate && this.run?.def.id === 'nap') {
      this.play('r-wake', 3, now);
    }
  }

  noteTyping(now = performance.now()) {
    this.typingUntil = now + 1500;
    this.lastUser = now;
    if (this.run && this.run.prio <= 1 && (this.run.def.moves || BIG.has(this.run.def.cat))) {
      this.stopRun();
      this.nextLifeAt = now + this.gap(now);
    }
  }

  /** Plays an action unless something more important is running. Higher `prio` wins. */
  play(id: string, prio = 2, now = performance.now()): boolean {
    const def = ACTION_BY_ID.get(id);
    if (!def || (this.run && this.run.prio > prio)) {
      return false;
    }
    this.stopRun();
    this.run = {
      def,
      prio,
      index: -1,
      ch: { s: 'face', a: 'none', ft: 'stand' },
      stepStart: now,
      stepDur: 0,
      waitMove: false,
      moved: false,
      poseStart: now,
    };
    this.host.onAction?.(def.label);
    this.recent.push(id);
    if (this.recent.length > 30) {
      this.recent.shift();
    }
    this.nextStep(now);
    return true;
  }

  /** A short change of face (and optionally gaze or arms) that does not interrupt the current action. */
  glance(face: string, ms: number, look?: Look, now = performance.now()) {
    this.overlay = { f: face, look, start: now, until: now + ms };
  }

  /** Clicking Lia: a pet, then dizziness, then a crash for the persistent. */
  pet(now = performance.now()) {
    this.noteActivity(true, now);
    if (this.run?.def.id === 'r-crash') {
      return;
    }
    this.clicks = this.clicks.filter((t) => now - t < 1800);
    this.clicks.push(now);
    this.mood.joy = clamp(this.mood.joy + 0.06, 0, 1);
    if (this.clicks.length >= 8) {
      this.clicks = [];
      this.play('r-crash', 3, now);
    } else if (this.clicks.length >= 5) {
      this.play('r-dizzy', 3, now);
    } else {
      this.play(`r-pet-${this.petIndex++ % PET_COUNT}`, 3, now);
    }
  }

  tick(now: number) {
    const dt = clamp((now - this.lastFrame) / 1000, 0, 0.05);
    this.lastFrame = now;
    const platform = this.host.platform();
    if (!platform) {
      return;
    }
    if (!this.placed) {
      this.gx = platform.x0 + (platform.x1 - platform.x0) * 0.75;
      this.placed = true;
    }
    this.updateRun(now);
    this.updateLife(dt, now);
    this.updateMotion(dt, now, platform);
    this.render(now);
  }

  /** Picks the next activity Lia does on her own, or null when nothing fits right now. */
  chooseLife(now = performance.now(), random = Math.random): string | null {
    const attention = this.attention(now);
    if (attention === 'busy') {
      return null;
    }
    const pools = new Map<Category, Array<[ActionDef, number]>>();
    for (const def of ACTIONS) {
      const base = CATEGORY_WEIGHT[def.cat];
      if (base == null || def.noAuto || (this.reducedMotion && def.moves)) {
        continue;
      }
      let w = def.weight;
      if (this.recent.includes(def.id)) {
        w *= 0.03;
      }
      if (def.tags.includes('sleepy')) {
        w *= this.mood.energy < 0.35 ? 6 : 0.2;
      }
      if (def.tags.includes('energetic')) {
        w *= this.mood.energy > 0.5 ? 1.4 : 0.2;
      }
      const big = def.moves || BIG.has(def.cat);
      if (big && attention === 'present') {
        w *= 0.06;
      } else if (big && attention === 'idle') {
        w *= 2;
      }
      const pool = pools.get(def.cat) ?? [];
      pool.push([def, w]);
      pools.set(def.cat, pool);
    }
    const categories = [...pools.keys()].map((cat): [Category, number] => {
      let sum = 0;
      let baseSum = 0;
      for (const [def, w] of pools.get(cat) ?? []) {
        sum += w;
        baseSum += def.weight;
      }
      return [cat, (CATEGORY_WEIGHT[cat] ?? 0) * clamp(baseSum ? sum / baseSum : 1, 0.03, 8)];
    });
    const cat = weighted(categories, random);
    const def = cat ? weighted(pools.get(cat) ?? [], random) : null;
    return def?.id ?? null;
  }

  private gap(now: number) {
    return this.attention(now) === 'idle'
      ? 1800 + Math.random() * 2700
      : 6000 + Math.random() * 6000;
  }

  private stopRun() {
    if (this.run) {
      this.run = null;
      this.host.onAction?.(null);
    }
    this.move = null;
  }

  private nextStep(now: number) {
    const run = this.run;
    if (!run) {
      return;
    }
    run.index += 1;
    const steps = run.def.steps;
    if (run.index >= steps.length) {
      const prio = run.prio;
      this.stopRun();
      this.nextLifeAt = now + (prio >= 2 ? 2500 + Math.random() * 2500 : this.gap(now));
      return;
    }
    const [dur, spec] = steps[run.index];
    const prevPose = run.ch.o;
    const { m, ...channels } = spec;
    Object.assign(run.ch, channels);
    if (run.ch.o !== prevPose || spec.o !== undefined) {
      run.poseStart = now;
    }
    run.stepStart = now;
    run.stepDur = stepDuration(dur);
    run.waitMove = m != null;
    run.moved = false;
    if (m) {
      this.startMove(m, run, now);
    }
  }

  private startMove(m: NonNullable<StepSpec['m']>, run: Run, now: number) {
    const platform = this.host.platform();
    if (!platform) {
      run.moved = true;
      return;
    }
    const tx = clamp(this.resolveTarget(m.to, platform), platform.x0, platform.x1);
    const style = m.style ?? 'walk';
    if (this.reducedMotion || style === 'teleport') {
      this.gx = tx;
      run.moved = true;
      return;
    }
    this.move = { tx, style, start: now, done: () => (run.moved = true) };
  }

  private resolveTarget(to: MoveTarget, p: Platform) {
    const S = this.scale;
    switch (to) {
      case 'left':
        return p.x0;
      case 'right':
        return p.x1;
      case 'pointer':
        return this.pointer?.x ?? this.gx;
      case 'near':
        return this.gx + (Math.random() < 0.5 ? -1 : 1) * (35 + Math.random() * 35) * S;
      default:
        return p.x0 + Math.random() * (p.x1 - p.x0);
    }
  }

  private updateRun(now: number) {
    const run = this.run;
    if (!run) {
      return;
    }
    if (run.waitMove && !run.moved && now - run.stepStart > MOVE_TIMEOUT_MS && this.move) {
      this.gx = this.move.tx;
      this.move = null;
      run.moved = true;
    }
    const elapsed = now - run.stepStart;
    const done = run.waitMove
      ? run.moved && (run.stepDur < 0 || elapsed >= run.stepDur)
      : elapsed >= run.stepDur;
    if (done) {
      this.nextStep(now);
    }
  }

  private updateLife(dt: number, now: number) {
    this.mood.energy = clamp(this.mood.energy - dt / 600, 0, 1);
    this.mood.joy += (0.55 - this.mood.joy) * dt * 0.01;
    if (this.run?.def.tags.includes('rest')) {
      this.mood.energy = clamp(this.mood.energy + dt / 25, 0, 1);
    }
    if (!this.life || this.run || now < this.nextLifeAt) {
      return;
    }
    const id = this.chooseLife(now);
    if (id) {
      this.play(id, 1, now);
    } else {
      this.nextLifeAt = now + 1000;
    }
  }

  private updateMotion(dt: number, now: number, platform: Platform) {
    const S = this.scale;
    const pose = { ox: 0, oy: 0, rot: 0, sx: 1, sy: 1 };
    this.gy = platform.y;
    const move = this.move;
    if (move) {
      const style = STYLES[move.style];
      const d = move.tx - this.gx;
      const stepPx = style.speed * S * dt * (this.mood.energy < 0.3 ? 0.7 : 1);
      if (Math.abs(d) <= stepPx) {
        this.gx = move.tx;
        this.move = null;
        this.landAt = now;
        move.done();
      } else {
        this.gx += Math.sign(d) * stepPx;
        const t = now - move.start;
        if (style.hop) {
          pose.oy -= Math.round(Math.abs(Math.sin(t / 170)) * style.hop);
        }
        if (style.bob) {
          pose.oy -= toggle(t, 150);
        }
        if (style.tilt) {
          pose.rot += Math.sign(d) * style.tilt;
        }
        if (style.pose) {
          Object.assign(pose, POSES[style.pose]?.(t, 0));
        }
      }
    }
    this.gx = clamp(this.gx, platform.x0, platform.x1);

    if (!this.reducedMotion) {
      const overlay = this.overlay && now < this.overlay.until ? this.overlay : null;
      const name = overlay?.o ?? this.run?.ch.o;
      const fn = name ? POSES[name] : undefined;
      if (fn) {
        const run = this.run;
        const fromOverlay = overlay?.o != null;
        const t = fromOverlay && overlay ? now - overlay.start : now - (run?.poseStart ?? now);
        let p = 0.5;
        if (fromOverlay && overlay) {
          p = clamp((now - overlay.start) / (overlay.until - overlay.start), 0, 1);
        } else if (run && run.stepDur > 0) {
          p = clamp((now - run.stepStart) / run.stepDur, 0, 1);
        }
        const v = fn(t, p);
        pose.ox += v.ox ?? 0;
        pose.oy += v.oy ?? 0;
        pose.rot += v.rot ?? 0;
        pose.sx *= v.sx ?? 1;
        pose.sy *= v.sy ?? 1;
      }
      const since = now - this.landAt;
      if (since < 110) {
        pose.sy *= 0.88;
        pose.sx *= 1.1;
      } else if (since < 385) {
        pose.rot += [-4, 3, -2, 1, 0][Math.min(4, Math.floor((since - 110) / 55))];
      }
    }
    this.pose = pose;
    const left = Math.round((this.gx - 32 * S + pose.ox * S) / S) * S;
    const top = Math.round((this.gy - FOOT_Y * S + pose.oy * S) / S) * S;
    this.canvas.style.transform = `translate(${left}px, ${top}px) rotate(${pose.rot}deg) scale(${pose.sx}, ${pose.sy})`;
    this.host.onFrame?.({ x: this.gx, y: this.gy - HEAD_ROWS * S + pose.oy * S });
  }

  private lookAt(look: Look | null | undefined): { dx: number; dy: number } {
    const S = this.scale;
    const face = { x: this.gx, y: this.gy - 26 * S };
    let target: Point | null = null;
    switch (look) {
      case 'caret':
        target = this.caret;
        break;
      case 'up':
        target = { x: face.x, y: face.y - 100 * S };
        break;
      case 'down':
        target = { x: face.x, y: face.y + 100 * S };
        break;
      case 'left':
        target = { x: face.x - 100 * S, y: face.y };
        break;
      case 'right':
        target = { x: face.x + 100 * S, y: face.y };
        break;
      default:
        target = this.pointer;
    }
    if (!target) {
      return { dx: 0, dy: 0 };
    }
    return {
      dx: clamp(Math.round((target.x - face.x) / (40 * S)), -1, 1),
      dy: clamp(Math.round((target.y - face.y) / (40 * S)), -1, 1),
    };
  }

  private moodFace() {
    if (this.mood.energy < 0.3) {
      return 'sleepy';
    }
    return this.mood.joy > 0.85 ? 'content' : 'neutral';
  }

  private render(now: number) {
    const c = this.ctx;
    if (!c || now - this.lastDraw < 60) {
      return;
    }
    this.lastDraw = now;
    const t = this.reducedMotion ? 900 : now;
    const overlay = this.overlay && now < this.overlay.until ? this.overlay : null;
    const ch: Channels = this.run?.ch ?? { s: 'face', a: 'none', ft: 'stand' };
    const moodFace = this.moodFace();
    const face = overlay?.f ?? ch.f ?? moodFace;
    if (face !== this.expression.name) {
      this.expression = { name: face, start: now };
    }
    const screen = ch.s ?? 'face';
    if (screen !== this.screen.name) {
      const dur = this.run && this.run.stepDur > 0 ? this.run.stepDur : 1000;
      this.screen = { name: screen, start: now, dur };
    }
    const typing = now < this.typingUntil;
    const look = this.lookAt(overlay?.look ?? ch.look ?? (typing ? 'caret' : 'pointer'));
    if (now > this.nextBlink) {
      this.blinkUntil = now + 130;
      this.nextBlink = now + 2400 + Math.random() * 3200;
    }

    c.clearRect(0, 0, GRID_W, GRID_H);
    let led: string = Math.floor(now / 1400) % 3 !== 2 ? C.LED : C.LO;
    if (screen === 'bsod') {
      led = C.VEIN;
    }
    drawBody(c, led);
    c.save();
    c.translate(SX, SY);
    c.beginPath();
    c.rect(0, 0, SCREEN_W, SCREEN_H);
    c.clip();
    const screenT = this.reducedMotion ? 900 : now - this.screen.start;
    drawScreen(c, screen, screenT, clamp((now - this.screen.start) / this.screen.dur, 0, 1), {
      face: EXPRESSION_BY_KEY.has(face) ? face : 'neutral',
      elapsed: now - this.expression.start,
      dx: look.dx,
      dy: look.dy,
      feather: true,
      t,
      blink: !this.reducedMotion && now < this.blinkUntil,
    });
    for (let y = 1; y < SCREEN_H; y += 2) {
      rect(c, 0, y, SCREEN_W, 1, 'rgba(0,0,0,0.09)');
    }
    c.restore();
    drawFeet(c, this.move ? STYLES[this.move.style].feet : (ch.ft ?? 'stand'), t);
    const armName = overlay?.a ?? ch.a ?? 'none';
    const armT = this.reducedMotion ? 400 : now - (this.run?.poseStart ?? now);
    const progress =
      this.run && this.run.stepDur > 0
        ? clamp((now - this.run.stepStart) / this.run.stepDur, 0, 1)
        : 0;
    const arms = (ARMS[armName] ?? ARMS.none)(armT, progress);
    drawArm(c, BX - 1, BY + 15, arms.l);
    drawArm(c, BX + 40, BY + 15, arms.r);

    const bubble = ch.b ?? null;
    if (bubble !== this.bubble) {
      this.bubble = bubble;
      this.host.onBubble(bubble);
    }
  }
}

function stepDuration(dur: Duration) {
  if (dur === 'move') {
    return -1;
  }
  if (typeof dur === 'number') {
    return dur;
  }
  return dur[0] + Math.random() * (dur[1] - dur[0]);
}

function weighted<T>(items: ReadonlyArray<readonly [T, number]>, random: () => number): T | null {
  let total = 0;
  for (const [, w] of items) {
    total += w;
  }
  if (total <= 0) {
    return null;
  }
  let r = random() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r <= 0) {
      return item;
    }
  }
  return items[items.length - 1][0];
}
