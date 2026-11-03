import type { UIActionResult } from '@mcp-ui/client';

const REPORT_ID = '([A-Za-z0-9_-]{8,64})';
const PROMPT_PATTERN = new RegExp(
  `\\bPDF\\b[^\\n]*?\\breport(?:\\s+id)?[\\s:#]+\`?${REPORT_ID}`,
  'i',
);
const ID_PATTERN = new RegExp(`^${REPORT_ID}$`);

const readReportId = (params: Record<string, unknown> | undefined): string | undefined => {
  const id = params?.report_id ?? params?.reportId;
  return typeof id === 'string' && ID_PATTERN.test(id) ? id : undefined;
};

/**
 * Recognizes the TSPI "Download PDF" button, whichever action shape the panel sends, so the
 * PDF is fetched straight from the server instead of being handed to the model.
 */
export function getTspiPdfReportId(result: UIActionResult): string | undefined {
  if (result.type === 'prompt') {
    return PROMPT_PATTERN.exec(result.payload.prompt ?? '')?.[1];
  }
  if (result.type === 'intent' && /pdf/i.test(result.payload.intent ?? '')) {
    return readReportId(result.payload.params);
  }
  if (result.type === 'tool' && /pdf/i.test(result.payload.toolName ?? '')) {
    return readReportId(result.payload.params);
  }
  return undefined;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/i;

export interface TspiConfirmationAction {
  confirmationId: string;
  decision: 'confirm' | 'cancel';
  payloadSha256: string;
}

export interface TspiOpenPatientAction {
  patientId: string;
  patientNumber?: string;
}

const intentParams = (
  result: UIActionResult,
  intent: string,
): Record<string, unknown> | undefined =>
  result.type === 'intent' && result.payload.intent === intent ? result.payload.params : undefined;

/**
 * Recognizes the TSPI Confirm / Cancel buttons on a pending change (M04). The click goes to
 * TspiChat's own route and on to the TSPI Brain, never to the model, so the model cannot confirm.
 */
export function getTspiConfirmation(result: UIActionResult): TspiConfirmationAction | undefined {
  const params = intentParams(result, 'tspi.confirmation');
  const id = params?.confirmation_id;
  const sha = params?.payload_sha256;
  const decision = params?.decision;
  if (typeof id !== 'string' || !SAFE_ID.test(id) || typeof sha !== 'string' || !SHA256.test(sha)) {
    return undefined;
  }
  if (decision !== 'confirm' && decision !== 'cancel') {
    return undefined;
  }
  return { confirmationId: id, decision, payloadSha256: sha };
}

/** Recognizes the TSPI Open button on a patient (M04). */
export function getTspiOpenPatient(result: UIActionResult): TspiOpenPatientAction | undefined {
  const params = intentParams(result, 'tspi.open_patient');
  const id = params?.patient_id;
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    return undefined;
  }
  const number = params?.patient_number;
  return { patientId: id, patientNumber: typeof number === 'string' ? number : undefined };
}

/** A TSPI intent this chat handles itself; never forwarded to the model, even when malformed. */
export function isTspiIntent(result: UIActionResult): boolean {
  return result.type === 'intent' && /^tspi\./.test(result.payload.intent ?? '');
}

export function getAttachmentFilename(disposition: string | undefined, fallback: string): string {
  const match = /filename="?([^";]+)"?/i.exec(disposition ?? '');
  return match?.[1] ?? fallback;
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
