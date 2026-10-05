import type { NativeMediaPort } from '@librechat/agents';
import type { NativeMediaFactory, NativeMediaSelection } from './native';
import { MediaServiceError } from './errors';

/** Agent construction stays synchronous; admission resolves this request-bound port before invocation. */
export function createDeferredNativeMediaPort(
  factory: NativeMediaFactory,
  selection: NativeMediaSelection,
): NativeMediaPort {
  let pending: ReturnType<NativeMediaFactory> | undefined;
  const resolve = () => (pending ??= factory(selection));
  return {
    async start(input) {
      const port = await resolve();
      if (!port && selection.responseModalities?.some((item) => item.toUpperCase() === 'IMAGE')) {
        throw new MediaServiceError(
          'unsupported',
          422,
          'Native media is not configured for this model.',
        );
      }
      return port?.start(input);
    },
    async part(input) {
      const port = await resolve();
      if (port) return port.part(input);
      if (input.part.kind === 'text') return { type: 'text', text: input.part.text };
      throw new MediaServiceError('unsupported', 422, 'Native media requires configured storage.');
    },
    async complete(input) {
      await (await resolve())?.complete(input);
    },
    async fail(input) {
      /** An admission failure has no provider-side work to reconcile. */
      const port = await pending?.catch(() => undefined);
      await port?.fail(input);
    },
    async restore(input) {
      const port = await resolve();
      if (!port)
        throw new MediaServiceError('not_found', 404, 'Native continuation is unavailable.');
      return port.restore(input);
    },
    async restoreBatch(input) {
      const port = await resolve();
      if (!port)
        throw new MediaServiceError('not_found', 404, 'Native continuation is unavailable.');
      if (port.restoreBatch) return port.restoreBatch(input);
      const result = [];
      for (const part of input.parts) {
        input.signal?.throwIfAborted();
        result.push(await port.restore(part));
      }
      return result;
    },
  };
}
