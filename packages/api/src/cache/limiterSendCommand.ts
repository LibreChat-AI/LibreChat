import type { SendCommandFn } from 'rate-limit-redis';

const isNoScriptError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.toUpperCase() === 'NOSCRIPT') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('NOSCRIPT ');
};

/**
 * Redis Cluster loads a script on one node, while EVALSHA routes to the node
 * that owns the command's key. Cache each loaded script so a NOSCRIPT reply can
 * fall back to EVAL on the correctly routed node.
 */
export const createClusterSafeSendCommand = (execute: SendCommandFn): SendCommandFn => {
  const scriptsBySha = new Map<string, string>();

  return async (...args: string[]) => {
    const command = args[0]?.toUpperCase();
    try {
      const result = await execute(...args);
      if (
        command === 'SCRIPT' &&
        args[1]?.toUpperCase() === 'LOAD' &&
        typeof args[2] === 'string' &&
        typeof result === 'string'
      ) {
        scriptsBySha.set(result, args[2]);
      }
      return result;
    } catch (error) {
      const script = command === 'EVALSHA' ? scriptsBySha.get(args[1]) : undefined;
      if (script == null || !isNoScriptError(error)) {
        throw error;
      }
      return execute('EVAL', script, ...args.slice(2));
    }
  };
};
