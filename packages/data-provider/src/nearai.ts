import { z } from 'zod';

/** Limits imposed by the Cloud UI v1 iframe protocol. */
const MAX_REPORT_BYTES = 1024 * 1024;
const text = z.string().min(1).max(MAX_REPORT_BYTES);
export const DEFAULT_NEAR_AI_VERIFICATION_TIMEOUT_MS = 45_000;
export const MAX_NEAR_AI_VERIFICATION_TIMEOUT_MS = 120_000;
export const DEFAULT_NEAR_AI_REPORT_CACHE_TTL_MS = 5 * 60 * 1000;
export const nearAIConfigSchema = z
  .object({
    verifyUrl: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) &&
          !url.username &&
          !url.password &&
          !url.hash &&
          url.pathname === '/verify'
        );
      }, 'Expected a trusted HTTPS /verify page or a localhost test viewer')
      .default('https://cloud.near.ai/verify'),
    receiptTimeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
    sessionCacheMax: z.number().int().min(1).max(10_000).default(256),
    reportCacheMax: z.number().int().min(1).max(1000).default(128),
    reportCacheTtlMs: z
      .number()
      .int()
      .min(0)
      .max(DEFAULT_NEAR_AI_REPORT_CACHE_TTL_MS)
      .default(DEFAULT_NEAR_AI_REPORT_CACHE_TTL_MS),
    verificationTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(MAX_NEAR_AI_VERIFICATION_TIMEOUT_MS)
      .default(DEFAULT_NEAR_AI_VERIFICATION_TIMEOUT_MS),
  })
  .strict();
const signer = z.object({
  signingAlgo: z.enum(['ed25519', 'ecdsa']),
  signingAddress: text,
});

/** Explicit display fields; deployment config and unknown fields are stripped. */
const report = z.object({
  schemaVersion: z.literal(1),
  completionId: text.optional(),
  model: z.preprocess((value) => (value === null ? undefined : value), text.optional()),
  scope: z.enum(['model', 'gateway', 'unknown']),
  status: z.enum(['verified', 'partial', 'failed', 'unverifiable']),
  verifiedAt: z.string().datetime({ offset: true }),
  signature: z
    .object({
      kind: z.enum(['provider_tee', 'gateway']),
      signer,
      signedText: text,
      signature: text,
    })
    .optional(),
  attestation: z
    .object({
      signer,
      tcbStatus: z.enum([
        'UpToDate',
        'SWHardeningNeeded',
        'ConfigurationNeeded',
        'ConfigurationAndSWHardeningNeeded',
        'OutOfDate',
        'OutOfDateConfigurationNeeded',
        'Revoked',
        'Unknown',
      ]),
      advisoryIds: z.array(text).max(1000),
      deploymentProvenance: z.enum(['verified', 'not_checked']),
      deployment: z.object({
        runtimeMeasurements: z.object({
          osImageHash: text.optional(),
          composeHash: text.optional(),
        }),
      }),
      gpuEvidence: z.enum(['verified', 'not_provided']).optional(),
      signingPublicKey: text.optional(),
      tlsBinding: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('none') }),
          z.object({ kind: z.literal('attested'), spkiFingerprint: text }),
        ])
        .optional(),
    })
    .optional(),
  error: z.object({ code: text, message: text }).optional(),
  evidence: z
    .object({
      intelQuote: text,
      nonce: text,
      eventLog: text,
      reportedQuoteData: text.optional(),
      nvidiaPayload: text.optional(),
    })
    .optional(),
});

/** Normalize saved reports written before Cloud UI renamed reply to response. */
export const nearAIVerificationReportSchema = z.preprocess(
  (value) =>
    value != null && typeof value === 'object' && 'kind' in value && value.kind === 'reply'
      ? { ...value, kind: 'response' }
      : value,
  z
    .discriminatedUnion('kind', [
      report.extend({ kind: z.literal('response'), completionId: text }),
      report.extend({ kind: z.literal('model'), model: text }),
    ])
    .refine(
      (report) => new TextEncoder().encode(JSON.stringify([report])).length <= MAX_REPORT_BYTES,
      {
        message: 'Verification report exceeds the viewer limit',
      },
    ),
);

export type TNearAIVerificationReport = z.infer<typeof nearAIVerificationReportSchema>;

export function hasVerifiedReports(reports?: TNearAIVerificationReport[]): boolean {
  return (
    !!reports?.length &&
    reports.every(({ status }) => status === 'verified' || status === 'partial')
  );
}

/** NEAR AI deployment attestation, verified server-side by the inference SDK. */
export type TNearAIAttestationResponse =
  | { enabled: false }
  | {
      enabled: true;
      model: string;
      status: 'verified' | 'partial' | 'failed';
      scope?: 'model' | 'gateway';
      checkedAt: string;
      expiresAt?: string;
      errorCode?: string;
      reports?: TNearAIVerificationReport[];
    };

/** Signature check for one NEAR AI completion, saved on the reply's `metadata.nearai.receipts`. */
export type TNearAIReceipt = {
  completionId: string;
  model: string;
  status: 'verified' | 'failed';
  verifiedAt: string;
  signatureKind?: 'provider_tee' | 'gateway';
  signingAlgo?: string;
  signingAddress?: string;
  signedText?: string;
  signature?: string;
  errorCode?: string;
  /** Selected SDK verification evidence for the Cloud UI iframe; absent on older messages. */
  report?: TNearAIVerificationReport;
};

export type TNearAIAttestationParams = {
  endpoint: string;
  model: string;
  refresh?: boolean;
  /** Fetch fresh display evidence without resetting the verified Chat session. */
  force?: boolean;
  reports?: boolean;
  scope?: 'gateway';
};
