export const MESSAGE_CONTENT_LAYOUT_CHANGE_EVENT = 'librechat:message-content-layout-change';
const MESSAGE_SCROLL_CONTAINER_SELECTOR = '.scrollbar-gutter-stable';
const MESSAGE_LAYOUT_RECONCILE_DURATION_MS = 350;

function getNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function getContentElement(scrollEl: HTMLElement): HTMLElement | null {
  return scrollEl.firstElementChild instanceof HTMLElement ? scrollEl.firstElementChild : null;
}

export function getRenderedContentMaxScrollTop(scrollEl: HTMLElement): number {
  const scrollHeightMax = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  const contentEl = getContentElement(scrollEl);
  if (!contentEl) {
    return scrollHeightMax;
  }

  const scrollRect = scrollEl.getBoundingClientRect();
  const contentRect = contentEl.getBoundingClientRect();
  if (scrollRect.height === 0 && contentRect.height === 0 && scrollEl.clientHeight > 0) {
    return scrollHeightMax;
  }

  const contentBottom = contentRect.bottom - scrollRect.top + scrollEl.scrollTop;
  const renderedMax = Math.max(0, Math.ceil(contentBottom - scrollEl.clientHeight));

  return Math.min(scrollHeightMax, renderedMax);
}

export function reconcileMessageContentLayout(target: HTMLElement | null): boolean {
  const scrollEl = target?.closest<HTMLElement>(MESSAGE_SCROLL_CONTAINER_SELECTOR) ?? null;
  if (!scrollEl) {
    return false;
  }

  const maxScrollTop = getRenderedContentMaxScrollTop(scrollEl);
  if (scrollEl.scrollTop <= maxScrollTop) {
    return false;
  }

  scrollEl.scrollTop = maxScrollTop;
  return true;
}

export function scheduleMessageContentLayoutReconcile(target: HTMLElement | null): () => void {
  reconcileMessageContentLayout(target);
  if (
    !target ||
    typeof window === 'undefined' ||
    typeof window.requestAnimationFrame !== 'function'
  ) {
    return () => {};
  }

  const startedAt = getNow();
  let animationFrameId: number | undefined;
  const reconcile = () => {
    reconcileMessageContentLayout(target);
    if (getNow() - startedAt >= MESSAGE_LAYOUT_RECONCILE_DURATION_MS) {
      animationFrameId = undefined;
      return;
    }
    animationFrameId = window.requestAnimationFrame(reconcile);
  };

  animationFrameId = window.requestAnimationFrame(reconcile);
  return () => {
    if (animationFrameId !== undefined) {
      window.cancelAnimationFrame(animationFrameId);
    }
  };
}

export function dispatchMessageContentLayoutChange(target: HTMLElement | null): void {
  reconcileMessageContentLayout(target);
  if (!target || typeof CustomEvent === 'undefined') {
    return;
  }

  target.dispatchEvent(
    new CustomEvent(MESSAGE_CONTENT_LAYOUT_CHANGE_EVENT, {
      bubbles: true,
    }),
  );
}
