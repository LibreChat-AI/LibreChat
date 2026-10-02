import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Bubble, LabelKey, Platform } from './engine/types';
import type { TranslationKeys } from '~/hooks';
import { GRID_W, GRID_H, FOOT_Y } from './engine/body';
import { LiaEngine } from './engine/engine';
import { freeSpan } from './engine/span';
import { useLocalize } from '~/hooks';
import { SAY } from './speech';

const SCALE = 2;
/** Lia's half width plus a margin, so she never stands past the end of the composer. */
const EDGE = 22 * SCALE;
/** Below this stage width there is no room beside the greeting, so Lia stays away. */
const MIN_WIDTH = 360;
/** How far above the composer Lia reaches, raised arms included; content there is avoided. */
const HEIGHT = 50 * SCALE;

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
  for (const prop of [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'paddingLeft',
    'paddingRight',
    'paddingTop',
  ] as const) {
    mirror.style[prop] = style[prop];
  }
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
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [activity, setActivity] = useState<LabelKey | null>(null);
  const engineRef = useRef<LiaEngine | null>(null);
  const leavingRef = useRef(leaving);

  useEffect(() => {
    leavingRef.current = leaving;
    if (leaving) {
      engineRef.current?.play('r-send', 4);
    }
  }, [leaving]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) {
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
    const platform = (): Platform | null => {
      const band = bandRef.current;
      if (!band || root.clientWidth < MIN_WIDTH) {
        canvas.style.visibility = 'hidden';
        return null;
      }
      const origin = root.getBoundingClientRect();
      const box = band.getBoundingClientRect();
      const top = box.top - origin.top;
      /* While leaving, the conversation replaces the welcome content and Lia rides the composer down. */
      const obstacles = leavingRef.current ? [] : measureObstacles(band);
      const blocked = obstacles
        .filter((o) => o.bottom - origin.top > top - HEIGHT && o.top - origin.top < top)
        .map((o) => [o.left - origin.left - EDGE, o.right - origin.left + EDGE] as const);
      const span = freeSpan(
        box.left - origin.left + EDGE,
        box.right - origin.left - EDGE,
        blocked,
        placed?.position.x ?? Infinity,
        EDGE,
      );
      canvas.style.visibility = span ? 'visible' : 'hidden';
      return span ? { y: top + 1, x0: span[0], x1: span[1] } : null;
    };
    const engine = new LiaEngine(canvas, {
      platform,
      onBubble: setBubble,
      onAction: setActivity,
      onFrame: (head) => {
        if (bubbleRef.current) {
          bubbleRef.current.style.transform = `translate(${Math.round(head.x + 10 * SCALE)}px, ${Math.round(head.y - 6 * SCALE)}px) translateY(-100%)`;
        }
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
        return;
      }
      cooldowns.set(id, now);
      cooldowns.set('*', now);
      engine.play(id, 2, now);
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
      engine.noteTyping(now);
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
      if (!longShown && target.value.length > 280) {
        longShown = true;
        react('r-long', 1000);
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

    const onPet = () => engine.pet();
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
    canvas.addEventListener('click', onPet);
    canvas.addEventListener('pointerenter', onHover);

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
      canvas.removeEventListener('click', onPet);
      canvas.removeEventListener('pointerenter', onHover);
      motion.removeEventListener('change', onMotion);
      themeObserver.disconnect();
      mirror.remove();
    };
  }, [bandRef]);

  let bubbleText: string | null = null;
  if (bubble != null) {
    bubbleText = 'say' in bubble ? localize(SAY[bubble.say]) : bubble.symbol;
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        data-testid="lia"
        title={
          activity
            ? localize('com_ui_lia_doing', { 0: localize(activity as TranslationKeys) })
            : undefined
        }
        className="pointer-events-auto absolute top-0 left-0 z-[5] cursor-pointer [image-rendering:pixelated]"
        style={{
          width: GRID_W * SCALE,
          height: GRID_H * SCALE,
          transformOrigin: `${32 * SCALE}px ${(FOOT_Y - 1) * SCALE}px`,
        }}
      />
      <div
        ref={bubbleRef}
        className="absolute top-0 left-0 z-20 max-w-48 whitespace-nowrap"
        hidden={bubbleText == null}
      >
        <span className="border-border-medium bg-surface-primary text-text-primary block rounded-lg border px-2 py-1 text-xs font-medium shadow-sm">
          {bubbleText}
        </span>
      </div>
    </div>
  );
}
