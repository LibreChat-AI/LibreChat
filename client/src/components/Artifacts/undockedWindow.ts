/**
 * DOM plumbing for the undocked artifacts pane.
 *
 * The pane stays part of the host window's React tree and is portaled into a
 * popup document, so artifacts keep streaming into it and the editor keeps its
 * state while the user drags the window to another screen. A portal moves
 * nodes, not the document that styled them, so everything the popup needs from
 * the host — stylesheets, the resolved theme, the Sandpack message channel —
 * has to be mirrored explicitly.
 */

/**
 * Window names are shared between same-origin tabs that can reach each other,
 * and reusing one would let a second tab's undock take over the first tab's
 * window — leaving that pane portaled into a document nobody can see. One name
 * per loaded tab keeps them apart while still reusing this tab's own window.
 */
export const UNDOCKED_ARTIFACTS_WINDOW_NAME = `librechat-artifacts-${Math.random()
  .toString(36)
  .slice(2, 10)}`;
export const UNDOCKED_ARTIFACTS_BOUNDS_KEY = 'artifacts:undocked-window-bounds';

const MIN_WIDTH = 520;
const MIN_HEIGHT = 480;
/** CSSOM rule insertion (Monaco's dynamic rules) mutates no DOM node, so the
 *  style observer never fires for it. Re-check the cheap signatures instead. */
const RESYNC_INTERVAL_MS = 1000;
/** Above this, a sheet is a compiled bundle: serialize its rules once per tick
 *  and the mirror would cost more than the pane it is mirroring. */
const MAX_SERIALIZED_RULES = 400;
const STYLE_SELECTOR = 'style, link[rel~="stylesheet"]';
const MIRRORED_ROOT_ATTRIBUTES = ['class', 'style', 'data-theme', 'lang', 'dir'];
const ROOT_ELEMENT_ID = 'undocked-artifacts-root';

export interface UndockedWindowBounds {
  width: number;
  height: number;
  left: number;
  top: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Screen coordinates are signed: a monitor left of the primary one reports a
 *  negative `left`, so only the size is clamped. */
export function parseBounds(raw: string | null): UndockedWindowBounds | null {
  if (raw == null || raw === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<UndockedWindowBounds>;
    if (
      !isFiniteNumber(parsed.width) ||
      !isFiniteNumber(parsed.height) ||
      !isFiniteNumber(parsed.left) ||
      !isFiniteNumber(parsed.top)
    ) {
      return null;
    }
    return {
      width: Math.max(MIN_WIDTH, Math.round(parsed.width)),
      height: Math.max(MIN_HEIGHT, Math.round(parsed.height)),
      left: Math.round(parsed.left),
      top: Math.round(parsed.top),
    };
  } catch {
    return null;
  }
}

export function defaultBounds(source: Window): UndockedWindowBounds {
  const availableWidth = source.screen?.availWidth ?? source.outerWidth ?? MIN_WIDTH;
  const availableHeight = source.screen?.availHeight ?? source.outerHeight ?? MIN_HEIGHT;
  const width = Math.max(MIN_WIDTH, Math.round(availableWidth * 0.45));
  const height = Math.max(MIN_HEIGHT, Math.round(availableHeight * 0.85));
  return {
    width,
    height,
    left: Math.round((source.screenX ?? 0) + Math.max(0, (source.outerWidth - width) / 2)),
    top: Math.round(source.screenY ?? 0) + 32,
  };
}

const readStorage = (storage: Storage | undefined, key: string): string | null => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

/**
 * Opens (or refocuses) the popup that hosts the undocked pane. Returns `null`
 * when the browser blocked it, which is the caller's cue to tell the user.
 * Must run inside the click handler: popup permission follows user activation.
 */
export function openUndockedWindow(source: Window): Window | null {
  const bounds =
    parseBounds(readStorage(source.localStorage, UNDOCKED_ARTIFACTS_BOUNDS_KEY)) ??
    defaultBounds(source);
  const features = [
    'popup=yes',
    `width=${bounds.width}`,
    `height=${bounds.height}`,
    `left=${bounds.left}`,
    `top=${bounds.top}`,
  ].join(',');

  const opened = source.open('', UNDOCKED_ARTIFACTS_WINDOW_NAME, features);
  if (opened == null) {
    return null;
  }
  opened.focus();
  return opened;
}

/** Remembers where the user put the window so the next undock lands there. */
export function persistBounds(detached: Window, storage: Storage | undefined): void {
  try {
    const bounds: UndockedWindowBounds = {
      width: detached.outerWidth,
      height: detached.outerHeight,
      left: detached.screenX,
      top: detached.screenY,
    };
    /* A window mid-teardown reports zeroes, or nothing at all. */
    if (!isFiniteNumber(bounds.width) || bounds.width <= 0 || bounds.height <= 0) {
      return;
    }
    storage?.setItem(UNDOCKED_ARTIFACTS_BOUNDS_KEY, JSON.stringify(bounds));
  } catch {
    /* window already torn down, or storage denied */
  }
}

/**
 * Clears whatever the popup already holds and installs the portal container.
 * A named window is reused across undocks, so this has to be repeatable. The
 * layout rules live in an injected sheet rather than inline styles, because
 * the theme mirror overwrites the `<html>` style attribute wholesale.
 */
export function prepareUndockedDocument(source: Document, target: Document): HTMLElement {
  target.head.querySelectorAll('[data-undocked-artifacts]').forEach((node) => node.remove());

  /* The popup's own URL is `about:blank`, so relative asset URLs in mirrored
   * styles and markup need the host's base to resolve against. */
  const base = target.createElement('base');
  base.dataset.undockedArtifacts = 'base';
  base.href = source.baseURI;
  target.head.appendChild(base);

  const layout = target.createElement('style');
  layout.dataset.undockedArtifacts = 'layout';
  layout.textContent = [
    'html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }',
    'body { background-color: rgb(var(--surface-primary)); }',
    `#${ROOT_ELEMENT_ID} { display: flex; height: 100%; width: 100%; overflow: hidden; }`,
  ].join('\n');
  target.head.appendChild(layout);

  const root = target.createElement('div');
  root.id = ROOT_ELEMENT_ID;
  target.body.replaceChildren(root);
  return root;
}

const copyAttributes = (source: Element, target: Element, names: string[]): void => {
  for (const name of names) {
    const value = source.getAttribute(name);
    if (value == null) {
      target.removeAttribute(name);
    } else if (target.getAttribute(name) !== value) {
      target.setAttribute(name, value);
    }
  }
};

/**
 * Keeps the popup on the host's theme. The palette is a set of custom
 * properties on `<html>` plus an appearance class, both of which change while
 * the window is open (theme switch, high contrast), so mirror them live.
 */
export function mirrorDocumentTheme(source: Document, target: Document): () => void {
  const apply = () => {
    copyAttributes(source.documentElement, target.documentElement, MIRRORED_ROOT_ATTRIBUTES);
    copyAttributes(source.body, target.body, ['class']);
  };

  apply();
  const observer = new MutationObserver(apply);
  observer.observe(source.documentElement, {
    attributes: true,
    attributeFilter: MIRRORED_ROOT_ATTRIBUTES,
  });
  observer.observe(source.body, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

interface MirroredSheet {
  source: Element;
  clone: HTMLStyleElement | HTMLLinkElement;
  signature: string;
}

const readableRules = (element: Element): CSSRuleList | null => {
  try {
    return (element as HTMLStyleElement).sheet?.cssRules ?? null;
  } catch {
    /* opaque cross-origin sheet */
    return null;
  }
};

const serializeRules = (rules: CSSRuleList): string => {
  const parts: string[] = [];
  for (let index = 0; index < rules.length; index += 1) {
    parts.push(rules[index].cssText);
  }
  return parts.join('\n');
};

/**
 * The text to clone, and a signature that changes whenever that text does.
 *
 * A sheet the page drives through the CSSOM (Monaco's dynamic rules, CSS-in-JS)
 * can gain, lose or replace a rule without touching a single node, and its
 * source text may stay empty or keep its length. Those sheets are small, so
 * their serialized rules are both the content and the signature. A large sheet
 * — the compiled Tailwind bundle — is only ever rewritten through its text
 * node, which the mutation observer sees, so it is compared by cheap shape
 * instead of being serialized every second.
 */
const styleSnapshot = (element: Element): { text: string; signature: string } => {
  const text = element.textContent ?? '';
  const rules = readableRules(element);
  if (rules != null && rules.length <= MAX_SERIALIZED_RULES) {
    const serialized = serializeRules(rules);
    return { text: serialized === '' ? text : serialized, signature: `rules|${serialized}` };
  }
  return { text, signature: `text|${text.length}|${rules?.length ?? -1}` };
};

const sheetSnapshot = (element: Element): { text: string; signature: string } => {
  if (element.tagName === 'LINK') {
    const link = element as HTMLLinkElement;
    return { text: '', signature: `link|${link.href}|${link.media}` };
  }
  return styleSnapshot(element);
};

const createClone = (element: Element, target: Document): HTMLStyleElement | HTMLLinkElement => {
  if (element.tagName === 'LINK') {
    const source = element as HTMLLinkElement;
    const clone = target.createElement('link');
    clone.rel = source.rel;
    clone.href = source.href;
    clone.media = source.media;
    if (source.type !== '') {
      clone.type = source.type;
    }
    if (source.crossOrigin != null) {
      clone.crossOrigin = source.crossOrigin;
    }
    return clone;
  }

  const source = element as HTMLStyleElement;
  const clone = target.createElement('style');
  clone.media = source.media;
  clone.textContent = styleSnapshot(source).text;
  return clone;
};

/**
 * Mirrors every host stylesheet into the popup and keeps them current: lazy
 * route chunks add sheets, dev HMR rewrites them, Monaco inserts rules.
 */
export function mirrorDocumentStyles(source: Document, target: Document): () => void {
  let mirrored: MirroredSheet[] = [];
  /* Nodes the observer saw change: a rewrite that keeps the same text length
   * is invisible to the signature, so the record decides instead. */
  const touched = new Set<Element>();

  const sync = () => {
    const nodes = Array.from(source.querySelectorAll(STYLE_SELECTOR));
    const unchangedSet =
      nodes.length === mirrored.length &&
      nodes.every((node, index) => mirrored[index].source === node);

    if (!unchangedSet) {
      for (const entry of mirrored) {
        entry.clone.remove();
      }
      mirrored = nodes.map((node) => {
        const clone = createClone(node, target);
        target.head.appendChild(clone);
        return { source: node, clone, signature: sheetSnapshot(node).signature };
      });
      touched.clear();
      return;
    }

    for (const entry of mirrored) {
      const { text, signature } = sheetSnapshot(entry.source);
      if (signature === entry.signature && !touched.has(entry.source)) {
        continue;
      }
      entry.signature = signature;
      if (entry.clone.tagName === 'STYLE') {
        (entry.clone as HTMLStyleElement).textContent = text;
      } else {
        (entry.clone as HTMLLinkElement).href = (entry.source as HTMLLinkElement).href;
      }
    }
    touched.clear();
  };

  sync();

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const node = record.target;
      const element = node instanceof Element ? node : node.parentElement;
      const sheet = element?.closest(STYLE_SELECTOR);
      if (sheet != null) {
        touched.add(sheet);
      }
    }
    sync();
  });
  observer.observe(source.head, { childList: true, subtree: true, characterData: true });
  const interval = source.defaultView?.setInterval(sync, RESYNC_INTERVAL_MS);

  return () => {
    observer.disconnect();
    if (interval != null) {
      source.defaultView?.clearInterval(interval);
    }
    for (const entry of mirrored) {
      entry.clone.remove();
    }
    mirrored = [];
    touched.clear();
  };
}

/**
 * Sandpack listens for preview frames on the window its module was loaded in —
 * the host window — while an iframe inside the popup posts to `window.parent`,
 * which is the popup. Re-dispatch those frames on the host, preserving
 * `source` so Sandpack's "is this my iframe?" check still matches; without this
 * the preview would sit at its loading state forever once undocked.
 */
export function relayFrameMessages(source: Window, detached: Window): () => void {
  const relay = (event: MessageEvent) => {
    if (event.source == null || event.source === detached || event.source === source) {
      return;
    }
    source.dispatchEvent(
      new MessageEvent('message', {
        data: event.data,
        origin: event.origin,
        lastEventId: event.lastEventId,
        source: event.source,
        ports: [...event.ports],
      }),
    );
  };

  detached.addEventListener('message', relay);
  return () => detached.removeEventListener('message', relay);
}
