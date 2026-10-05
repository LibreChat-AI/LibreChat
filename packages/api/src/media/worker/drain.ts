/** A dispatch admitted before drain must finish handing off before preparation can return. */
export function createMediaDispatchGate() {
  let open = true;
  const pending = new Set<Promise<void>>();
  return {
    get accepting() {
      return open;
    },
    open() {
      open = true;
    },
    async close() {
      open = false;
      await Promise.allSettled(pending);
    },
    enter(): (() => void) | undefined {
      if (!open) return;
      let complete: () => void = () => undefined;
      const ticket = new Promise<void>((resolve) => {
        complete = resolve;
      });
      pending.add(ticket);
      return () => {
        pending.delete(ticket);
        complete();
      };
    },
  };
}

/** Wait within the caller's remaining budget without leaving a timer after early completion. */
export async function waitForMediaDrain(work: Promise<void>, budgetMs: number): Promise<void> {
  if (budgetMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
