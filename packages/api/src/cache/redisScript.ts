import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Redis, Cluster } from 'ioredis';

export type RedisScriptArg = string | number | Buffer;
export type RedisScriptResult = string | number | boolean | null | undefined | RedisScriptResult[];
export type RedisScriptClient = Pick<Redis | Cluster, 'eval' | 'evalsha'>;

const scriptShas = new Map<string, string>();
const evalOnlyClients = new WeakSet<object>();
const fallbackContext = new AsyncLocalStorage<boolean>();

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NOSCRIPT ');
}

function isUnsupportedEvalsha(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /^(?:NOPERM .*|ERR unknown command )['"]?evalsha['"]?(?:\s|,|$)/i.test(error.message);
}

export function isEvalshaFallbackInProgress(error: unknown): boolean {
  return (
    fallbackContext.getStore() === true && (isNoScriptError(error) || isUnsupportedEvalsha(error))
  );
}

/**
 * For independent operations only: a NOSCRIPT fallback can execute after later commands.
 * Callers must await prerequisites and results before dependent work. Ordered stream
 * writes/publications use direct EVAL instead. Only static script bodies belong here.
 * Network, script-runtime, and other ambiguous failures are never retried by this helper.
 */
export async function evalScript(
  client: RedisScriptClient,
  script: string,
  numberOfKeys: number,
  ...args: RedisScriptArg[]
): Promise<RedisScriptResult> {
  if (evalOnlyClients.has(client)) {
    return (await client.eval(script, numberOfKeys, ...args)) as RedisScriptResult;
  }
  let sha = scriptShas.get(script);
  if (sha == null) {
    sha = createHash('sha1').update(script).digest('hex');
    scriptShas.set(script, sha);
  }
  try {
    return (await fallbackContext.run(true, () =>
      client.evalsha(sha, numberOfKeys, ...args),
    )) as RedisScriptResult;
  } catch (error) {
    const unsupported = isUnsupportedEvalsha(error);
    if (!isNoScriptError(error) && !unsupported) {
      throw error;
    }
    if (unsupported) {
      evalOnlyClients.add(client);
    }
    return (await client.eval(script, numberOfKeys, ...args)) as RedisScriptResult;
  }
}
