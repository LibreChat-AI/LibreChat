import axios from 'axios';
import { logger } from '@librechat/data-schemas';
import {
  STTProviders,
  sttRealtimeDelays,
  listConfiguredSpeechProviders,
  RealtimeTranscriptionErrorCode,
} from 'librechat-data-provider';
import type { RealtimeTranscriptionRequest } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { AxiosRequestConfig } from 'axios';
import type { OpenAISTTConfig, TranscriptionHints, STTConfig } from './transcription';
import { getTranscriptionHints, usesTranscriptionHints } from './transcription';
import { applySSRFSafeAgentIfDirect } from '~/auth/agent';
import { applyAxiosProxyConfig } from '~/utils/proxy';
import { resolveConfigSecret } from '~/admin/secrets';
import { getSafeErrorMetadata } from '~/utils';

const DEFAULT_REALTIME_URL = 'https://api.openai.com/v1';
/** Browser offers are a few KB; the cap only bounds what is forwarded upstream. */
const MAX_OFFER_LENGTH = 64 * 1024;
const MAX_LANGUAGE_LENGTH = 35;
/** The secret is spent on the SDP exchange that immediately follows it. */
const CLIENT_SECRET_TTL_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 15_000;

type RealtimeDelay = (typeof sttRealtimeDelays)[number];

export interface RealtimeTranscriptionTarget {
  openai: OpenAISTTConfig;
  /** Realtime API base URL without a trailing slash. */
  url: string;
  model: string;
  delay?: RealtimeDelay;
  allowedAddresses?: string[];
}

export interface RealtimeTranscriptionSession {
  type: 'transcription';
  audio: {
    input: {
      format: { type: 'audio/pcm'; rate: 24000 };
      transcription: TranscriptionHints & { model: string; delay?: RealtimeDelay };
      turn_detection: null;
    };
  };
}

export type RealtimeTranscriptionResult =
  | { ok: true; sdp: string }
  | { ok: false; status: number; code: RealtimeTranscriptionErrorCode };

/**
 * Resolves the live transcription target, or `null` when live dictation is off. It
 * requires the same single-provider STT config the recorded path accepts, so live
 * dictation is never offered on a config the rest of speech-to-text would reject.
 */
export function getRealtimeTranscriptionTarget(
  stt?: STTConfig | null,
): RealtimeTranscriptionTarget | null {
  const providers = listConfiguredSpeechProviders(stt as Record<string, unknown> | undefined);
  if (providers.length !== 1 || providers[0][0] !== STTProviders.OPENAI) {
    return null;
  }
  const openai = stt?.openai;
  const realtime = openai?.realtime;
  const model = realtime?.model?.trim();
  if (openai == null || !model) {
    return null;
  }
  const delay = sttRealtimeDelays.find((value) => value === realtime?.delay);
  return {
    openai,
    model,
    url: (realtime?.url?.trim() || DEFAULT_REALTIME_URL).replace(/\/+$/, ''),
    ...(delay && { delay }),
    ...(stt?.allowedAddresses && { allowedAddresses: stt.allowedAddresses }),
  };
}

export function isRealtimeTranscriptionAvailable(stt?: STTConfig | null): boolean {
  return getRealtimeTranscriptionTarget(stt) != null;
}

/**
 * A transcription-only session. Turn detection is off so a turn ends only when the
 * browser commits the audio buffer: `gpt-live-transcribe` has no server VAD, and for
 * older models it keeps a pause from splitting one dictation into several items.
 */
export function buildRealtimeTranscriptionSession(
  target: Pick<RealtimeTranscriptionTarget, 'openai' | 'model' | 'delay'>,
  language?: string | null,
): RealtimeTranscriptionSession {
  const transcription: RealtimeTranscriptionSession['audio']['input']['transcription'] = {
    model: target.model,
    ...getTranscriptionHints(target.openai, target.model, language),
  };
  if (target.delay && usesTranscriptionHints(target.model)) {
    transcription.delay = target.delay;
  }
  return {
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription,
        turn_detection: null,
      },
    },
  };
}

function guarded(
  url: string,
  config: AxiosRequestConfig,
  allowedAddresses?: string[],
): AxiosRequestConfig {
  applyAxiosProxyConfig(config, url);
  applySSRFSafeAgentIfDirect(config, url, allowedAddresses);
  return config;
}

/**
 * Opens a live transcription call for the browser's WebRTC offer and returns the
 * provider's answer. The configured key only mints a short-lived client secret, and
 * that secret is spent here on the SDP exchange, so neither credential reaches the
 * browser. Azure OpenAI's `/realtime/calls` accepts only these ephemeral secrets.
 */
export async function createRealtimeTranscriptionCall(
  target: RealtimeTranscriptionTarget,
  offer: string,
  language?: string | null,
): Promise<string> {
  const apiKey = resolveConfigSecret(target.openai.apiKey) || '';
  const secretUrl = `${target.url}/realtime/client_secrets`;
  const secretResponse = await axios.post(
    secretUrl,
    {
      expires_after: { anchor: 'created_at', seconds: CLIENT_SECRET_TTL_SECONDS },
      session: buildRealtimeTranscriptionSession(target, language),
    },
    guarded(
      secretUrl,
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        timeout: REQUEST_TIMEOUT_MS,
      },
      target.allowedAddresses,
    ),
  );
  const secret: unknown = secretResponse.data?.value;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('The provider did not return a client secret');
  }

  const callsUrl = `${target.url}/realtime/calls`;
  const answer = await axios.post<unknown>(
    callsUrl,
    offer,
    guarded(
      callsUrl,
      {
        headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${secret}` },
        responseType: 'text',
        timeout: REQUEST_TIMEOUT_MS,
      },
      target.allowedAddresses,
    ),
  );
  if (typeof answer.data !== 'string' || !answer.data.startsWith('v=0')) {
    throw new Error('The provider did not return an SDP answer');
  }
  return answer.data;
}

function isOffer(sdp: unknown): sdp is string {
  return typeof sdp === 'string' && sdp.length <= MAX_OFFER_LENGTH && sdp.startsWith('v=0');
}

/** Validates the browser's offer and opens the call. Provider failures are logged without their content. */
export async function openRealtimeTranscription(
  stt: STTConfig | null | undefined,
  body: Partial<RealtimeTranscriptionRequest> | undefined,
): Promise<RealtimeTranscriptionResult> {
  const target = getRealtimeTranscriptionTarget(stt);
  if (target == null) {
    return { ok: false, status: 404, code: RealtimeTranscriptionErrorCode.NOT_CONFIGURED };
  }
  const sdp = body?.sdp;
  if (!isOffer(sdp)) {
    return { ok: false, status: 400, code: RealtimeTranscriptionErrorCode.INVALID_OFFER };
  }
  const language =
    typeof body?.language === 'string' && body.language.length <= MAX_LANGUAGE_LENGTH
      ? body.language
      : undefined;
  try {
    return { ok: true, sdp: await createRealtimeTranscriptionCall(target, sdp, language) };
  } catch (error) {
    logger.error('[STT] Failed to open a live transcription session:', getSafeErrorMetadata(error));
    return { ok: false, status: 502, code: RealtimeTranscriptionErrorCode.PROVIDER_ERROR };
  }
}

type RealtimeTranscriptionHttpRequest = Request<
  unknown,
  unknown,
  Partial<RealtimeTranscriptionRequest> | undefined
> & { config?: AppConfig };

/**
 * `POST /api/files/speech/stt/realtime`. Transcripts stream from the provider straight
 * to the browser, so unlike the recorded path they are not inspected by transcript
 * content filters.
 */
export function createRealtimeTranscriptionHandler() {
  return async function createRealtimeTranscription(
    req: RealtimeTranscriptionHttpRequest,
    res: Response,
  ): Promise<Response> {
    const result = await openRealtimeTranscription(req.config?.speech?.stt, req.body);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.code });
    }
    return res.status(200).json({ sdp: result.sdp });
  };
}
