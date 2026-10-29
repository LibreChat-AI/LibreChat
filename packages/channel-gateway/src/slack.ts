import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebClient, LogLevel, WebAPIPlatformError, WebAPIRateLimitedError } from '@slack/web-api';
import type { Block, KnownBlock, View } from '@slack/types';
import type { WebAPICallResult } from '@slack/web-api';
import type { GatewayConfig } from './config';
import type { Logger } from './types';

export type SlackBlocks = (Block | KnownBlock)[];
export type SlackView = View;
export type SlackWriteOutcome = 'permanent' | 'retryable' | 'unknown';
export interface SlackMessage {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: SlackBlocks;
}
export interface SlackMessageReceipt {
  channel: string;
  ts: string;
}
interface SlackResult extends WebAPICallResult {
  channel?: unknown;
  ts?: unknown;
  warning?: unknown;
  warnings?: unknown;
  file_id?: unknown;
  upload_url?: unknown;
  files?: unknown;
}

export class SlackWriteError extends Error {
  constructor(
    readonly outcome: SlackWriteOutcome,
    readonly retryAfterMs = 0,
    readonly code: 'invalid_blocks' | 'invalid_attachments' | '' = '',
  ) {
    super(`Slack write ${outcome}`);
    this.name = 'SlackWriteError';
  }
}

const updates = new Set([
  'chat.update',
  'reactions.add',
  'reactions.remove',
  'agents.sessions.setStatus',
]);
const methods = new Set([
  ...updates,
  'chat.postMessage',
  'chat.postEphemeral',
  'conversations.open',
  'views.open',
  'views.update',
  'files.getUploadURLExternal',
  'files.completeUploadExternal',
]);
const diagnosticCodes = new Set([
  'invalid_arguments',
  'invalid_arg_name',
  'invalid_post_type',
  'invalid_json',
  'invalid_blocks',
  'invalid_attachments',
  'missing_scope',
  'not_allowed',
  'channel_not_found',
  'thread_not_found',
  'invalid_thread_ts',
  'invalid_status',
  'invalid_auth',
  'not_authed',
  'unknown_method',
  'method_not_supported_for_channel_type',
  'internal_error',
  'fatal_error',
  'ratelimited',
]);
const mutedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  setName() {},
  getLevel: () => LogLevel.ERROR,
};

/** Signed upload capabilities stay in memory; only Slack or exact loopback fixtures may receive bytes. */
export function validSlackUploadURL(raw: string, apiBase: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:' && url.host === 'files.slack.com') return true;
    const base = new URL(apiBase);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const loopback = isIP(host) && (host === '::1' || host.startsWith('127.'));
    return Boolean(
      loopback && url.protocol === 'http:' && base.protocol === 'http:' && url.host === base.host,
    );
  } catch {
    return false;
  }
}

export class SlackClient {
  constructor(
    private readonly config: Pick<GatewayConfig, 'SLACK_API_BASE_URL' | 'API_CALL_TIMEOUT_MS'>,
    private readonly logger?: Logger,
    private readonly transport: typeof fetch = fetch,
  ) {}

  private async call(
    token: string,
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    once = false,
  ): Promise<SlackResult> {
    const boundedSignal = AbortSignal.any([
      AbortSignal.timeout(this.config.API_CALL_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let retryAfterMs = 0;
      let validEnvelope = false;
      const client = new WebClient(token, {
        slackApiUrl: this.config.SLACK_API_BASE_URL.replace(/\/?$/, '/'),
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        allowAbsoluteUrls: false,
        logger: mutedLogger,
        fetch: async (url, init) => {
          const response = await this.transport(url, {
            ...init,
            signal: boundedSignal,
            redirect: 'error',
          });
          status = response.status;
          const seconds = Number(response.headers.get('retry-after'));
          retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            while (reader) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > 1024 * 1024) throw new Error('Slack response too large');
              chunks.push(chunk.value);
            }
          } finally {
            await reader?.cancel();
            reader?.releaseLock();
          }
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const envelope: { ok?: unknown; error?: unknown } = JSON.parse(text);
            validEnvelope = Boolean(
              envelope &&
                (envelope.ok === true ||
                  (envelope.ok === false && typeof envelope.error === 'string')),
            );
          } catch {
            /* The SDK maps malformed bodies to a platform error; that is not a rejection. */
          }
          return new Response(text, { status: response.status, headers: response.headers });
        },
      });
      try {
        boundedSignal.throwIfAborted();
        return await client.apiCall(method, payload);
      } catch (error) {
        if (
          error instanceof WebAPIPlatformError &&
          ((method === 'reactions.add' && error.data.error === 'already_reacted') ||
            (method === 'reactions.remove' && error.data.error === 'no_reaction'))
        )
          return { ok: true };
        const uncertain: SlackWriteOutcome = !once && updates.has(method) ? 'retryable' : 'unknown';
        let outcome: SlackWriteOutcome = uncertain;
        if (status === 429 || error instanceof WebAPIRateLimitedError) {
          outcome = 'retryable';
          if (error instanceof WebAPIRateLimitedError) retryAfterMs = error.retryAfter * 1000;
        } else if (error instanceof WebAPIPlatformError && validEnvelope) {
          outcome = ['internal_error', 'fatal_error'].includes(error.data.error)
            ? uncertain
            : 'permanent';
        } else if (status && (status < 200 || status >= 300) && status < 500) {
          outcome = 'permanent';
        }
        const code =
          validEnvelope &&
          error instanceof WebAPIPlatformError &&
          (error.data.error === 'invalid_blocks' || error.data.error === 'invalid_attachments')
            ? error.data.error
            : '';
        const failure = new SlackWriteError(outcome, retryAfterMs, code);
        const operation = methods.has(method) ? method : 'unknown';
        let reason = status ? 'http_error' : 'transport_error';
        if (boundedSignal.aborted) reason = 'cancelled';
        if (error instanceof WebAPIPlatformError && validEnvelope)
          reason = diagnosticCodes.has(error.data.error) ? error.data.error : 'platform_error';
        this.logger?.warn(`slack_api_call_failed:${operation}:${status}:${reason}`);
        const wait = retryAfterMs || 200 * 2 ** attempt;
        if (
          once ||
          !updates.has(method) ||
          outcome !== 'retryable' ||
          attempt >= 2 ||
          wait > 5000 ||
          boundedSignal.aborted
        )
          throw failure;
        try {
          await delay(wait, undefined, { signal: boundedSignal });
        } catch {
          throw failure;
        }
      }
    }
  }

  async postMessage(
    token: string,
    message: SlackMessage,
    signal?: AbortSignal,
  ): Promise<SlackMessageReceipt> {
    const result = await this.call(
      token,
      'chat.postMessage',
      {
        ...message,
        parse: 'none',
        unfurl_links: false,
        unfurl_media: false,
      },
      signal,
    );
    return this.messageReceipt(result, message.channel);
  }

  /** A rejected rich payload created nothing; only that explicit rejection permits a text fallback. */
  async deliverPart(
    token: string,
    message: SlackMessage,
    signal?: AbortSignal,
  ): Promise<SlackMessageReceipt> {
    try {
      return await this.postMessage(token, message, signal);
    } catch (error) {
      if (
        !message.blocks?.length ||
        !(error instanceof SlackWriteError) ||
        (error.code !== 'invalid_blocks' && error.code !== 'invalid_attachments')
      )
        throw error;
      return this.postMessage(token, { ...message, blocks: [] }, signal);
    }
  }

  async updateMessage(
    token: string,
    message: SlackMessage & { ts: string },
    signal?: AbortSignal,
  ): Promise<SlackMessageReceipt> {
    const result = await this.call(token, 'chat.update', { ...message, parse: 'none' }, signal);
    const receipt = this.messageReceipt(result, message.channel);
    if (receipt.ts !== message.ts) throw new SlackWriteError('unknown');
    return receipt;
  }

  /** Durable progress has its own persisted attempt; even an update must not hide another write. */
  async updateMessageOnce(
    token: string,
    message: SlackMessage & { ts: string },
    signal?: AbortSignal,
  ): Promise<SlackMessageReceipt> {
    const result = await this.call(
      token,
      'chat.update',
      { ...message, parse: 'none' },
      signal,
      true,
    );
    const receipt = this.messageReceipt(result, message.channel);
    if (receipt.ts !== message.ts) throw new SlackWriteError('unknown');
    return receipt;
  }

  private messageReceipt(result: SlackResult, channel: string): SlackMessageReceipt {
    if (
      result.channel !== channel ||
      typeof result.ts !== 'string' ||
      !/^\d+\.\d+$/.test(result.ts)
    )
      throw new SlackWriteError('unknown');
    return { channel, ts: result.ts };
  }

  async ephemeral(
    token: string,
    message: SlackMessage & { user: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(
      token,
      'chat.postEphemeral',
      {
        ...message,
        parse: 'none',
        unfurl_links: false,
        unfurl_media: false,
      },
      signal,
    );
  }

  async openConversation(token: string, user: string, signal?: AbortSignal): Promise<string> {
    const result = await this.call(token, 'conversations.open', { users: user }, signal);
    if (
      !result.channel ||
      typeof result.channel !== 'object' ||
      !('id' in result.channel) ||
      typeof result.channel.id !== 'string' ||
      !result.channel.id
    )
      throw new SlackWriteError('unknown');
    return result.channel.id;
  }

  async openView(
    token: string,
    triggerId: string,
    view: SlackView,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(token, 'views.open', { trigger_id: triggerId, view }, signal);
  }

  async updateView(
    token: string,
    viewId: string,
    view: SlackView,
    hash?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(
      token,
      'views.update',
      { view_id: viewId, view, ...(hash ? { hash } : {}) },
      signal,
    );
  }

  async reaction(
    token: string,
    action: 'add' | 'remove',
    channel: string,
    ts: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call(token, `reactions.${action}`, { channel, timestamp: ts, name }, signal);
  }

  async setSessionStatus(
    token: string,
    session: {
      channel: string;
      threadTs: string;
      status: 'processing' | 'suspended' | 'active' | 'closed';
      title?: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.call(
      token,
      'agents.sessions.setStatus',
      {
        channel_id: session.channel,
        thread_ts: session.threadTs,
        status: session.status,
        ...(session.title?.trim()
          ? { title: [...session.title.trim()].slice(0, 200).join('') }
          : {}),
      },
      signal,
    );
    if (
      result.warning === 'missing_agent_session_stopped_event_subscription' ||
      (Array.isArray(result.warnings) &&
        result.warnings.includes('missing_agent_session_stopped_event_subscription'))
    ) {
      this.logger?.warn('slack_native_status_missing_stop_subscription');
      throw new SlackWriteError('permanent');
    }
  }

  async allocateArtifact(
    token: string,
    filename: string,
    bytes: number,
    signal?: AbortSignal,
  ): Promise<{ fileId: string; uploadUrl: string }> {
    const result = await this.call(
      token,
      'files.getUploadURLExternal',
      { filename, length: bytes },
      signal,
    );
    if (
      typeof result.file_id !== 'string' ||
      !result.file_id ||
      result.file_id.length > 128 ||
      typeof result.upload_url !== 'string'
    )
      throw new SlackWriteError('unknown');
    // Checkpoint the known ID before validating its upload capability.
    return { fileId: result.file_id, uploadUrl: result.upload_url };
  }

  async uploadArtifact(url: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!validSlackUploadURL(url, this.config.SLACK_API_BASE_URL))
      throw new SlackWriteError('permanent');
    try {
      const response = await this.transport(url, {
        method: 'POST',
        body: Buffer.from(data),
        headers: { 'Content-Type': 'application/octet-stream' },
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(this.config.API_CALL_TIMEOUT_MS),
          ...(signal ? [signal] : []),
        ]),
      });
      await response.body?.cancel();
      if (response.status !== 200) throw new SlackWriteError('unknown');
    } catch {
      throw new SlackWriteError('unknown');
    }
  }

  async completeArtifact(
    token: string,
    file: { channel: string; threadTs: string; fileId: string; filename: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.call(
      token,
      'files.completeUploadExternal',
      {
        files: [{ id: file.fileId, title: file.filename }],
        channel_id: file.channel,
        thread_ts: file.threadTs,
      },
      signal,
    );
    if (
      !Array.isArray(result.files) ||
      result.files.length !== 1 ||
      !result.files[0] ||
      typeof result.files[0] !== 'object' ||
      !('id' in result.files[0]) ||
      result.files[0].id !== file.fileId
    )
      throw new SlackWriteError('unknown');
  }
}
