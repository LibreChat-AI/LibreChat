import { z } from 'zod';
import { nearAIVerificationReportSchema } from 'librechat-data-provider';
import type { TNearAIVerificationReport } from 'librechat-data-provider';

const messageSchema = z.object({
  type: z.enum([
    'NEAR_AI_VERIFICATION_CENTER_READY',
    'NEAR_AI_VERIFICATION_ERROR',
    'NEAR_AI_VERIFICATION_CLOSE',
  ]),
  version: z.literal(1),
  requestId: z.string().min(1),
});

export function verificationViewerUrl(value: string): URL {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !local) ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== '/verify'
  ) {
    throw new Error('Invalid verification viewer URL');
  }
  return url;
}

export function connectVerificationReport({
  iframe,
  reports,
  viewerUrl,
  onReady,
  onError,
  onClose,
}: {
  iframe: HTMLIFrameElement;
  reports: TNearAIVerificationReport[];
  viewerUrl: string;
  onReady: () => void;
  onError: () => void;
  onClose: () => void;
}): () => void {
  const viewer = verificationViewerUrl(viewerUrl);
  const safeReports = z.array(nearAIVerificationReportSchema).min(1).max(1000).parse(reports);
  if (new TextEncoder().encode(JSON.stringify(safeReports)).length > 1024 * 1024) {
    throw new Error('Verification reports exceed the viewer limit');
  }
  viewer.searchParams.set('canRequestReports', 'false');
  viewer.searchParams.set('canClose', 'true');
  let requestId = '';
  // Match the viewer's v1 report handshake timeout.
  const timer = setTimeout(onError, 60_000);
  const disconnect = () => {
    requestId = '';
    clearTimeout(timer);
    window.removeEventListener('message', receive);
    iframe.removeAttribute('src');
  };
  const receive = (event: MessageEvent<unknown>) => {
    if (event.origin !== viewer.origin || event.source !== iframe.contentWindow) {
      return;
    }
    const parsed = messageSchema.safeParse(event.data);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.type === 'NEAR_AI_VERIFICATION_CENTER_READY') {
      requestId = message.requestId;
      clearTimeout(timer);
      iframe.contentWindow?.postMessage(
        { type: 'NEAR_AI_VERIFICATION_REPORT', version: 1, requestId, reports: safeReports },
        viewer.origin,
      );
      onReady();
      return;
    }
    if (!requestId || message.requestId !== requestId) {
      return;
    }
    if (message.type === 'NEAR_AI_VERIFICATION_ERROR') {
      onError();
    } else if (message.type === 'NEAR_AI_VERIFICATION_CLOSE') {
      disconnect();
      onClose();
    }
  };
  window.addEventListener('message', receive);
  iframe.src = viewer.href;
  return disconnect;
}
