/** Each feature owns its work; update coordination may only ask whether leaving is safe. */
const guards = new Set<() => boolean>();
let pendingUploads = 0;

export function registerReloadGuard(guard: () => boolean): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

export function holdReloadForUpload(): () => void {
  pendingUploads++;
  let released = false;
  return () => {
    if (!released) {
      pendingUploads--;
      released = true;
    }
  };
}

export function hasRegisteredReloadGuard(): boolean {
  return guards.size > 0;
}

export function hasBlockingWork(): boolean {
  if (pendingUploads > 0) {
    return true;
  }
  for (const guard of guards) {
    try {
      if (guard()) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export function canLeave(anySubmitting: boolean): boolean {
  if (
    anySubmitting ||
    hasBlockingWork() ||
    document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')
  ) {
    return false;
  }
  for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="file"], input[type="url"], input[type="tel"], input[type="number"]',
  )) {
    if (input.value || (input instanceof HTMLInputElement && input.files?.length)) {
      return false;
    }
  }
  return !document.querySelector('[contenteditable="true"], [role="textbox"][contenteditable]');
}
