export interface TransactionData {
  user: string;
  conversationId: string;
  tokenType: string;
  model?: string;
  context?: string;
  valueKey?: string;
  rate?: number;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  messageId?: string;
  inputTokenCount?: number;
  rateDetail?: Record<string, number>;
}

/** Fixed-identity receipt shared by media settlement and balance auto-refill. */
export type CreditsTransactionInput = {
  user: string;
  tenantId: string | null;
  context: string;
  model?: string;
  rawAmount?: number;
  tokenValue?: number;
  inputTokens?: number;
  outputTokens?: number;
  costSource?: 'provider' | 'tokens' | 'estimate';
  mediaJobId?: string;
  debtCredits?: number;
  overrunDebtCredits?: number;
  holdShortfallCredits?: number;
  costUSD?: number;
  mediaFingerprint?: string;
} & (
  | { transactionId: string; mediaSettlementId?: never }
  | { transactionId?: never; mediaSettlementId: string }
);
export type CreditsTransactionWriter = (
  input: CreditsTransactionInput,
) => Promise<{ fingerprint?: string }>;
