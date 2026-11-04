import type { OAuthStartHandler, OAuthStartOptions } from '../types';

/** Publication completes before authorization, which may need to reacquire the caller's lease. */
export function invokeOAuthStart(
  handler: OAuthStartHandler | undefined,
  authURL: string,
  options?: Omit<OAuthStartOptions, 'onPublished'>,
): { published: Promise<void>; completed: Promise<void> } {
  let acknowledge!: () => void;
  let rejectPublication!: (error: unknown) => void;
  const published = new Promise<void>((resolve, reject) => {
    acknowledge = resolve;
    rejectPublication = reject;
  });
  const completed = Promise.resolve().then(() =>
    handler?.(authURL, { ...options, onPublished: acknowledge }),
  );
  // Emit-only legacy listeners finish at publication. Reentrant authorization listeners acknowledge
  // explicitly after their durable URL write, before starting work that requires the same lease.
  void completed.then(acknowledge, rejectPublication);
  void completed.catch(() => undefined);
  return { published, completed };
}

export function createOAuthCallback({
  runStepEmitter,
  runStepDeltaEmitter,
}: {
  runStepEmitter: () => Promise<void>;
  runStepDeltaEmitter: OAuthStartHandler;
}): OAuthStartHandler {
  return async (authURL, options) => {
    await runStepEmitter();
    await runStepDeltaEmitter(authURL, options);
    options?.onPublished?.();
  };
}
