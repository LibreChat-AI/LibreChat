import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@librechat/client';
import type { RefObject } from 'react';
import type { Bubble, LabelKey, Platform } from './engine/types';
import type { TranslationKeys } from '~/hooks';
import { BX, GRID_W, GRID_H, FOOT_Y, HEAD_ROWS } from './engine/body';
import { LiaEngine } from './engine/engine';
import { freeSpan } from './engine/span';
import { useLocalize } from '~/hooks';
import { SAY } from './speech';

const SCALE = 2;
/** Lia's half width plus a margin, so she never stands past the end of the composer. */
const EDGE = 22 * SCALE;
/** Below this stage width there is no room beside the greeting, so Lia stays away. */
const MIN_WIDTH = 360;
/** On the floor beside the composer, how far from its edge Lia may wander. */
const NEAR = 3 * EDGE;
/** How far above the composer Lia reaches, raised arms included; content there is avoided. */
const HEIGHT = 50 * SCALE;
/** Lia's body, the only part that takes clicks; the canvas around it is see-through room for
 * arms and props and lets clicks pass to the page. */
const BODY_W = (GRID_W - 2 * BX) * SCALE;
const BODY_H = HEAD_ROWS * SCALE;
/** How far one arrow key press carries Lia along the composer. */
const KEY_STEP = 24 * SCALE;

/** Words that make Lia react while you type them. */
const KEYWORDS: Readonly<Record<string, string>> = {
  hello: 'r-hello',
  hi: 'r-hello',
  hey: 'r-hello',
  thanks: 'r-thanks',
  thank: 'r-thanks',
  lia: 'r-name',
  love: 'r-love',
};

/** Where the caret sits inside a textarea, measured with a hidden mirror element. */
function caretPoint(textarea: HTMLTextAreaElement, mirror: HTMLDivElement, origin: DOMRect) {
  const style = getComputedStyle(textarea);
  /* Everything that moves text inside the box, so wrapping and right-to-left text match. */
  for (const prop of [
    'direction',
    'textAlign',
    'textIndent',
    'textTransform',
    'fontFamily',
    'fontSize',
    'fontStyle',
    'fontWeight',
    'fontVariant',
    'lineHeight',
    'letterSpacing',
    'wordSpacing',
    'tabSize',
    'wordBreak',
    'paddingLeft',
    'paddingRight',
    'paddingTop',
  ] as const) {
    mirror.style[prop] = style[prop];
  }
  /* clientWidth includes padding and excludes borders, so size the mirror's border box to it. */
  mirror.style.boxSizing = 'border-box';
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.textContent = textarea.value.slice(0, textarea.selectionEnd);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  const box = textarea.getBoundingClientRect();
  return {
    x: box.left - origin.left + marker.offsetLeft,
    y: box.top - origin.top + marker.offsetTop - textarea.scrollTop,
  };
}

const hasFiles = (e: DragEvent) =>
  e.dataTransfer != null && [...e.dataTransfer.types].includes('Files');

export default function Stage({
  bandRef,
  leaving = false,
}: {
  bandRef: RefObject<HTMLElement>;
  /** The user just sent the first message: Lia waves it off and sinks behind the composer. */
  leaving?: boolean;
}) {
  const localize = useLocalize();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitRef = useRef<HTMLButtonElement>(null);
  const keysId = useId();
  const bubbleRef = useRef<HTMLDivElement>(null);
  /* Measured when the text changes, so placing the bubble each frame reads no layout. */
  const bubbleWidthRef = useRef(0);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [activity, setActivity] = useState<LabelKey | null>(null);
  const engineRef = useRef<LiaEngine | null>(null);
  const leavingRef = useRef(leaving);

  useEffect(() => {
    const wasLeaving = leavingRef.current;
    leavingRef.current = leaving;
    if (leaving) {
      engineRef.current?.play('r-send', 4);
    } else if (wasLeaving) {
      /* Back on the welcome screen before the farewell ended: drop it, she hides at its end. */
      engineRef.current?.play('intro', 4);
    }
  }, [leaving]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const hit = hitRef.current;
    if (!root || !canvas || !hit) {
      return;
    }
    /* The welcome content above the composer (greeting, agent name) is measured as obstacles,
     * cached briefly because layout only changes on resize and on content swaps. */
    let obstacles: DOMRect[] = [];
    let measuredAt = -Infinity;
    const measureObstacles = (band: HTMLElement) => {
      const now = performance.now();
      if (now - measuredAt < 250) {
        return obstacles;
      }
      measuredAt = now;
      obstacles = [];
      for (const child of Array.from(root.parentElement?.children ?? [])) {
        if (child === root || child === band) {
          continue;
        }
        const range = document.createRange();
        range.selectNodeContents(child);
        const box = range.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          obstacles.push(box);
        }
      }
      return obstacles;
    };
    let placed: LiaEngine | null = null;
    /* Where Lia's canvas may reach, so the bubble can stay inside the same room. */
    let room: readonly [number, number] = [0, Infinity];
    /* Set when the user drops her below the composer's middle, so she stays on the floor. */
    let floorFirst = false;
    /* The bubble belongs to Lia: whenever she has nowhere to stand, it goes with her. */
    const setVisible = (visible: boolean) => {
      const value = visible ? 'visible' : 'hidden';
      canvas.style.visibility = value;
      hit.style.visibility = value;
      if (bubbleRef.current) {
        bubbleRef.current.style.visibility = value;
      }
    };
    const platform = (): Platform | null => {
      const band = bandRef.current;
      if (!band || root.clientWidth < MIN_WIDTH) {
        setVisible(false);
        return null;
      }
      const origin = root.getBoundingClientRect();
      const box = band.getBoundingClientRect();
      const top = box.top - origin.top;
      /* The band runs below the visible composer, so the floor is the form's bottom edge. */
      const bottom =
        (band.querySelector('form') ?? band).getBoundingClientRect().bottom - origin.top;
      const left = box.left - origin.left;
      const right = box.right - origin.left;
      /* While leaving, the conversation replaces the welcome content and Lia rides the composer down. */
      const obstacles = leavingRef.current ? [] : measureObstacles(band);
      /* Where she can stand with her feet at `y`, clear of the content beside or above her.
       * Any gap that fits her body will do: in a narrow one she stands still. */
      const standAt = (y: number, x0: number, x1: number, extra: [number, number][]) =>
        freeSpan(
          x0,
          x1,
          obstacles
            .filter((o) => o.bottom - origin.top > y - HEIGHT && o.top - origin.top < y)
            .map((o) => [o.left - origin.left - EDGE, o.right - origin.left + EDGE] as const)
            .concat(extra),
          placed?.position.x ?? Infinity,
          0,
        );
      /* On top of the composer beside the greeting, or on the floor beside the composer, level
       * with its bottom edge: the top first, unless she was last dropped on the floor. */
      const onTop = () => standAt(top, left + EDGE, right - EDGE, []);
      const onFloor = () =>
        standAt(
          bottom,
          Math.max(EDGE, left - NEAR),
          Math.min(root.clientWidth - EDGE, right + NEAR),
          [[left - EDGE, right + EDGE]],
        );
      const order = floorFirst
        ? ([
            [bottom, onFloor],
            [top + 1, onTop],
          ] as const)
        : ([
            [top + 1, onTop],
            [bottom, onFloor],
          ] as const);
      for (const [y, find] of order) {
        const span = find();
        if (span) {
          setVisible(true);
          room = [Math.max(0, span[0] - EDGE), Math.min(root.clientWidth, span[1] + EDGE)];
          return { y, x0: span[0], x1: span[1] };
        }
      }
      setVisible(false);
      return null;
    };
    const engine = new LiaEngine(canvas, {
      platform,
      onBubble: setBubble,
      onAction: setActivity,
      onFrame: (head) => {
        /* The head point is the top of her body, centered. */
        hit.style.transform = `translate(${Math.round(head.x - BODY_W / 2)}px, ${Math.round(head.y)}px)`;
        const bubbleEl = bubbleRef.current;
        if (!bubbleEl) {
          return;
        }
        /* The bubble sits to Lia's right, flips left when that side has no room, and never
         * leaves the stage or the span she stands in. */
        const width = bubbleWidthRef.current;
        const [left, right] = room;
        let x = head.x + 10 * SCALE;
        if (x + width > right) {
          x = head.x - 10 * SCALE - width;
        }
        x = Math.max(left, Math.min(x, right - width));
        bubbleEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(head.y - 6 * SCALE)}px) translateY(-100%)`;
      },
    });
    placed = engine;
    engineRef.current = engine;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    engine.reducedMotion = motion.matches;
    const onMotion = () => {
      engine.reducedMotion = motion.matches;
    };
    motion.addEventListener('change', onMotion);

    const cooldowns = new Map<string, number>();
    const react = (id: string, ms = 6000) => {
      const now = performance.now();
      if (
        now - (cooldowns.get(id) ?? -Infinity) < ms ||
        now - (cooldowns.get('*') ?? -Infinity) < 1500
      ) {
        return false;
      }
      /* Wall time for the cooldowns; the engine keeps its own clock, paused while she has no room. */
      if (!engine.play(id, 2)) {
        return false;
      }
      cooldowns.set(id, now);
      cooldowns.set('*', now);
      return true;
    };

    const mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    Object.assign(mirror.style, {
      position: 'absolute',
      visibility: 'hidden',
      top: '0',
      left: '-9999px',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
    });
    document.body.appendChild(mirror);

    let keyTimes: number[] = [];
    let longShown = false;
    const onInput = (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLTextAreaElement)) {
        return;
      }
      const now = performance.now();
      engine.noteTyping();
      engine.caret = caretPoint(target, mirror, root.getBoundingClientRect());
      /* Deleting back under the threshold re-arms the reaction for the next long message. */
      if (target.value.length <= 280) {
        longShown = false;
      }
      const input = e as InputEvent;
      if (input.inputType === 'insertFromPaste') {
        if (target.value.length > 40) {
          react('r-paste', 8000);
        }
        return;
      }
      if (input.inputType?.startsWith('delete')) {
        return;
      }
      keyTimes = keyTimes.filter((k) => now - k < 1500);
      keyTimes.push(now);
      if (keyTimes.length >= 9 && engine.current == null) {
        react('r-type-fast', 12000);
      }
      /* Only a reaction that actually played uses up the long message; a busy Lia tries again. */
      if (!longShown && target.value.length > 280) {
        longShown = react('r-long', 1000);
      }
      const ch = input.data;
      if (ch === '?') {
        react('r-question', 10000);
      } else if (ch === '!') {
        react('r-exclaim', 10000);
      }
      if (ch && /[\s.,!?]/.test(ch)) {
        const word = target.value
          .slice(0, target.selectionEnd - 1)
          .toLowerCase()
          .match(/[a-z]+$/)?.[0];
        const id = word ? KEYWORDS[word] : undefined;
        if (id) {
          react(id, 8000);
        }
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof HTMLTextAreaElement) {
        engine.caret = caretPoint(e.target, mirror, root.getBoundingClientRect());
        engine.glance('curious', 900, 'caret');
        engine.noteActivity(true);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === 'a' &&
        e.target instanceof HTMLTextAreaElement &&
        e.target.value
      ) {
        react('r-select', 15000);
      }
    };

    let shakeDir = 0;
    let flips: number[] = [];
    /* Pointer events can outpace frames; read layout at most once per frame. */
    let pendingPointer: { x: number; y: number } | null = null;
    let pointerFrame = 0;
    const onPointerMove = (e: PointerEvent) => {
      pendingPointer = { x: e.clientX, y: e.clientY };
      if (!pointerFrame) {
        pointerFrame = requestAnimationFrame(processPointer);
      }
    };
    const processPointer = () => {
      pointerFrame = 0;
      const client = pendingPointer;
      pendingPointer = null;
      if (!client) {
        return;
      }
      const origin = root.getBoundingClientRect();
      const p = { x: client.x - origin.left, y: client.y - origin.top };
      const prev = engine.pointer;
      engine.pointer = p;
      engine.noteActivity();
      if (!prev) {
        return;
      }
      const now = performance.now();
      const head = engine.position;
      const near = Math.hypot(p.x - head.x, p.y - (head.y - 26 * SCALE)) < 80 * SCALE;
      const dir = Math.sign(p.x - prev.x);
      if (near && dir && dir !== shakeDir) {
        flips = flips.filter((k) => now - k < 700);
        flips.push(now);
        if (flips.length >= 6) {
          flips = [];
          react('r-shake', 10000);
        }
      }
      shakeDir = dir || shakeDir;
    };

    let dragDepth = 0;
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) {
        return;
      }
      dragDepth += 1;
      if (dragDepth === 1) {
        engine.noteActivity(true);
        engine.play('r-drag', 3);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) {
        return;
      }
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        engine.play('r-drag-cancel', 3);
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) {
        return;
      }
      dragDepth = 0;
      engine.play('r-drop', 3);
    };

    let dark = document.documentElement.classList.contains('dark');
    const themeObserver = new MutationObserver(() => {
      const next = document.documentElement.classList.contains('dark');
      if (next !== dark) {
        dark = next;
        engine.play(next ? 'r-dark' : 'r-light', 3);
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = performance.now();
      } else if (hiddenAt && performance.now() - hiddenAt > 5000) {
        react('r-welcome', 20000);
      }
    };

    /* Dragging her around: a press that moves past a few pixels picks her up, and letting go
     * drops her on the composer or the floor beside it, whichever is nearer. A press that does
     * not move stays a click, which pets her. */
    let grab: { id: number; x: number; y: number; dx: number; dy: number } | null = null;
    let dragging = false;
    let dragged = false;
    const feetAt = (e: PointerEvent) => {
      const origin = root.getBoundingClientRect();
      return {
        x: e.clientX - origin.left - (grab?.dx ?? 0),
        y: e.clientY - origin.top - (grab?.dy ?? 0) + BODY_H,
      };
    };
    const onGrab = (e: PointerEvent) => {
      if (e.button !== 0) {
        return;
      }
      const box = hit.getBoundingClientRect();
      grab = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        dx: e.clientX - box.left - BODY_W / 2,
        dy: e.clientY - box.top,
      };
      hit.setPointerCapture(e.pointerId);
    };
    const onCarry = (e: PointerEvent) => {
      if (!grab || e.pointerId !== grab.id) {
        return;
      }
      if (!dragging && Math.hypot(e.clientX - grab.x, e.clientY - grab.y) < 5) {
        return;
      }
      dragging = true;
      engine.hold(feetAt(e));
    };
    const onLetGo = (e: PointerEvent) => {
      if (!grab || e.pointerId !== grab.id) {
        return;
      }
      if (dragging) {
        const feet = feetAt(e);
        const band = bandRef.current;
        if (band) {
          const form = (band.querySelector('form') ?? band).getBoundingClientRect();
          const origin = root.getBoundingClientRect();
          floorFirst = feet.y > (form.top + form.bottom) / 2 - origin.top;
        }
        engine.release(feet.x);
        dragged = true;
      }
      grab = null;
      dragging = false;
    };
    const onPet = () => {
      if (dragged) {
        dragged = false;
        return;
      }
      engine.pet();
    };
    /* The keyboard's drag: each arrow press picks Lia up and sets her down a step along. */
    const onStep = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
        return;
      }
      e.preventDefault();
      const { x, y } = engine.position;
      const to = x + (e.key === 'ArrowLeft' ? -KEY_STEP : KEY_STEP);
      engine.hold({ x: to, y });
      engine.release(to);
    };
    const onHover = () => {
      if (engine.current == null && Math.random() < 0.4) {
        react('r-hover', 10000);
      } else {
        engine.glance('content', 800, 'pointer');
      }
    };

    const band = bandRef.current;
    band?.addEventListener('input', onInput);
    band?.addEventListener('focusin', onFocusIn);
    band?.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    document.addEventListener('visibilitychange', onVisibility);
    hit.addEventListener('pointerdown', onGrab);
    hit.addEventListener('pointermove', onCarry);
    hit.addEventListener('pointerup', onLetGo);
    hit.addEventListener('pointercancel', onLetGo);
    hit.addEventListener('click', onPet);
    hit.addEventListener('keydown', onStep);
    hit.addEventListener('pointerenter', onHover);

    engine.play(leavingRef.current ? 'r-send' : 'intro', 4);
    engine.start();
    return () => {
      engineRef.current = null;
      engine.stop();
      band?.removeEventListener('input', onInput);
      band?.removeEventListener('focusin', onFocusIn);
      band?.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointermove', onPointerMove);
      cancelAnimationFrame(pointerFrame);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      document.removeEventListener('visibilitychange', onVisibility);
      hit.removeEventListener('pointerdown', onGrab);
      hit.removeEventListener('pointermove', onCarry);
      hit.removeEventListener('pointerup', onLetGo);
      hit.removeEventListener('pointercancel', onLetGo);
      hit.removeEventListener('click', onPet);
      hit.removeEventListener('keydown', onStep);
      hit.removeEventListener('pointerenter', onHover);
      motion.removeEventListener('change', onMotion);
      themeObserver.disconnect();
      mirror.remove();
    };
  }, [bandRef]);

  let bubbleText: string | null = null;
  if (bubble != null) {
    bubbleText = 'say' in bubble ? localize(SAY[bubble.say]) : bubble.symbol;
  }

  const doing = localize('com_ui_lia_doing', {
    0: localize((activity ?? 'com_ui_lia_act_idle') as TranslationKeys),
  });

  useLayoutEffect(() => {
    bubbleWidthRef.current = bubbleRef.current?.offsetWidth ?? 0;
  }, [bubbleText]);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        data-testid="lia"
        className="absolute top-0 left-0 z-[5] [image-rendering:pixelated]"
        style={{
          width: GRID_W * SCALE,
          height: GRID_H * SCALE,
          transformOrigin: `${32 * SCALE}px ${(FOOT_Y - 1) * SCALE}px`,
        }}
      />
      {/* Lia herself: click or Enter to pet her, drag or the arrow keys to move her. */}
      <Button
        ref={hitRef}
        type="button"
        variant={null}
        size={null}
        data-testid="lia-body"
        title={doing}
        aria-label={doing}
        aria-describedby={keysId}
        aria-keyshortcuts="ArrowLeft ArrowRight"
        className="pointer-events-auto absolute top-0 left-0 z-[6] cursor-grab touch-none active:cursor-grabbing"
        style={{ width: BODY_W, height: BODY_H }}
      />
      <span id={keysId} className="sr-only">
        {localize('com_ui_lia_keys')}
      </span>
      <div
        ref={bubbleRef}
        aria-hidden="true"
        data-testid="lia-bubble"
        className="absolute top-0 left-0 z-20 w-max max-w-48"
        hidden={bubbleText == null}
      >
        <span className="border-border-medium bg-surface-primary text-text-primary block rounded-lg border px-2 py-1 text-xs font-medium shadow-sm">
          {bubbleText}
        </span>
      </div>
    </div>
  );
}
