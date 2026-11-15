import { createHash } from 'node:crypto';
import { channelSnowflakeSchema, discordPrivateReplySchema } from 'librechat-data-provider';
import type { DiscordPrivateReply } from 'librechat-data-provider';
import type { DiscordControlClient } from './control';
import type { DiscordRatePermit } from './rates';
import { DiscordRateCoordinator, DiscordRateQueueError } from './rates';
import { DiscordWriteError } from './client';
import { boundedBody } from '../transport';

/** Updates the known ephemeral original; uncertain PATCH results can safely repeat this exact reply. */
export class DiscordReplyClient {
  private readonly base: string;
  constructor(
    private readonly options: { timeoutMs: number; maxResponseBytes: number; apiBase?: string },
    private readonly transport: typeof fetch = fetch,
    private readonly rates: DiscordRateCoordinator = new DiscordRateCoordinator(),
  ) {
    const base = new URL(options.apiBase ?? 'https://discord.com/api/v10');
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.protocol !== 'https:' &&
        !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
    )
      throw new TypeError('Invalid Discord API base');
    if (
      ![options.timeoutMs, options.maxResponseBytes].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new TypeError('Invalid Discord reply policy');
    this.base = base.href.replace(/\/$/, '');
  }
  async write(
    applicationId: string,
    token: string,
    value: DiscordPrivateReply,
    signal?: AbortSignal,
  ): Promise<void> {
    channelSnowflakeSchema.parse(applicationId);
    if (!token || token.length > 4096) throw new TypeError('Invalid Discord interaction token');
    const reply = discordPrivateReplySchema.parse(value);
    const components = reply.actions?.length
      ? [
          {
            type: 1,
            components: reply.actions.map((action) =>
              'url' in action
                ? { type: 2, style: 5, label: action.label, url: action.url }
                : {
                    type: 2,
                    label: action.label,
                    custom_id: action.reference,
                    style: { primary: 1, secondary: 2, danger: 4 }[action.style],
                  },
            ),
          },
        ]
      : [];
    const scope = {
      route: 'PATCH /webhooks/:id/:token/messages/@original',
      major: `${applicationId}:${createHash('sha256').update(token).digest('hex')}`,
    };
    let permit: DiscordRatePermit;
    try {
      permit = await this.rates.acquire(scope, signal);
    } catch (error) {
      if (error instanceof DiscordRateQueueError)
        throw new DiscordWriteError('retryable', error.retryAfterMs);
      throw error;
    }
    try {
      let response: Response;
      let bytes: Buffer;
      try {
        response = await this.transport(
          `${this.base}/webhooks/${applicationId}/${encodeURIComponent(token)}/messages/@original`,
          {
            method: 'PATCH',
            redirect: 'error',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.any([
              AbortSignal.timeout(this.options.timeoutMs),
              ...(signal ? [signal] : []),
            ]),
            body: JSON.stringify({
              content: reply.content,
              components,
              allowed_mentions: { parse: [], replied_user: false },
            }),
          },
        );
      } catch {
        throw new DiscordWriteError('unknown');
      }
      permit.observe(response);
      try {
        bytes = await boundedBody(response, this.options.maxResponseBytes);
      } catch {
        if (response.status === 429)
          throw new DiscordWriteError('retryable', this.rates.retryAfter(response));
        throw new DiscordWriteError(
          response.status >= 400 && response.status < 500 ? 'permanent' : 'unknown',
        );
      }
      let payload: unknown;
      try {
        payload = bytes.length ? JSON.parse(bytes.toString()) : undefined;
      } catch {
        payload = undefined;
      }
      permit.observe(response, payload);
      if (response.status === 429) {
        const retryAfterMs = this.rates.retryAfter(response, payload);
        throw new DiscordWriteError('retryable', retryAfterMs);
      }
      if (!response.ok)
        throw new DiscordWriteError(
          response.status >= 400 && response.status < 500 ? 'permanent' : 'unknown',
        );
    } finally {
      permit.release();
    }
  }
}

/** One bounded turn. The owner schedules subsequent turns; this helper never creates retry timers. */
export async function deliverDiscordReply(
  deps: {
    applicationId: string;
    owner: string;
    control: Pick<DiscordControlClient, 'claim' | 'finish' | 'defer'>;
    reply: Pick<DiscordReplyClient, 'write'>;
    retryDelayMs: number;
    now?: () => number;
  },
  signal: AbortSignal,
): Promise<boolean> {
  if (!Number.isSafeInteger(deps.retryDelayMs) || deps.retryDelayMs <= 0)
    throw new TypeError('Invalid Discord retry policy');
  const now = deps.now ?? Date.now;
  signal.throwIfAborted();
  const job = await deps.control.claim(deps.applicationId, deps.owner, signal);
  if (!job) return false;
  signal.throwIfAborted();
  if (job.expiresAt <= now()) {
    await deps.control.finish(job.fence, 'expired', signal);
    return true;
  }
  // No unresolved job can reach external delivery or execute without the owned preflight adapter.
  if ('inspection' in job) {
    await deps.control.finish(job.fence, 'unavailable', signal);
    return true;
  }
  try {
    await deps.reply.write(
      deps.applicationId,
      job.token,
      job.reply,
      AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, job.expiresAt - now()))]),
    );
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof DiscordWriteError)) throw error;
    if (job.expiresAt <= now()) await deps.control.finish(job.fence, 'expired', signal);
    else if (error.outcome === 'permanent')
      await deps.control.finish(job.fence, 'unavailable', signal);
    else {
      const backoff = deps.retryDelayMs * 2 ** Math.min(job.fence.epoch - 1, 30);
      const delay = Math.max(error.retryAfterMs, backoff * (0.5 + Math.random() / 2));
      await deps.control.defer(
        job.fence,
        Math.min(job.expiresAt, now() + Math.ceil(delay)),
        signal,
      );
    }
    return true;
  }
  signal.throwIfAborted();
  await deps.control.finish(job.fence, 'completed', signal);
  return true;
}
