import { CANCEL_RATE } from '@librechat/data-schemas';
import type { TCustomConfig, TTransactionsConfig } from 'librechat-data-provider';
import type { TransactionData } from '@librechat/data-schemas';
import type { EndpointTokenConfig } from '~/types/tokens';

type TokenType = 'prompt' | 'completion';

interface GetMultiplierParams {
  valueKey?: string;
  tokenType?: TokenType;
  model?: string;
  endpointTokenConfig?: EndpointTokenConfig;
  inputTokenCount?: number;
}

interface GetCacheMultiplierParams {
  cacheType: 'write' | 'read';
  model?: string;
  endpointTokenConfig?: EndpointTokenConfig;
  inputTokenCount?: number;
}

export interface PricingFns {
  getMultiplier: (params: GetMultiplierParams) => number;
  getCacheMultiplier: (params: GetCacheMultiplierParams) => number | null;
}

interface BaseTxData {
  user: string;
  model?: string;
  context: string;
  messageId?: string;
  conversationId: string;
  endpointTokenConfig?: EndpointTokenConfig;
  balance?: Partial<TCustomConfig['balance']> | null;
  transactions?: Partial<TTransactionsConfig>;
}

interface StandardTxData extends BaseTxData {
  tokenType: TokenType;
  rawAmount: number;
  inputTokenCount?: number;
  valueKey?: string;
}

interface StructuredTxData extends BaseTxData {
  tokenType: TokenType;
  inputTokens?: number;
  writeTokens?: number;
  readTokens?: number;
  inputTokenCount?: number;
  rawAmount?: number;
}

export interface PreparedEntry {
  doc: TransactionData;
  tokenValue: number;
  balance?: Partial<TCustomConfig['balance']> | null;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface StructuredPromptTokens {
  input?: number;
  write?: number;
  read?: number;
}

export interface StructuredTokenUsage {
  promptTokens?: StructuredPromptTokens;
  completionTokens?: number;
}

export interface TxMetadata {
  user: string;
  model?: string;
  context: string;
  messageId?: string;
  conversationId: string;
  balance?: Partial<TCustomConfig['balance']> | null;
  transactions?: Partial<TTransactionsConfig>;
  endpointTokenConfig?: EndpointTokenConfig;
}

export interface BulkWriteDeps {
  insertMany: (docs: TransactionData[]) => Promise<unknown>;
  updateBalance: (params: { user: string; incrementValue: number }) => Promise<unknown>;
}

function calculateTokenValue(
  txData: StandardTxData,
  pricing: PricingFns,
): { tokenValue: number; rate: number } {
  const { tokenType, model, endpointTokenConfig, inputTokenCount, rawAmount, valueKey } = txData;
  const multiplier = Math.abs(
    pricing.getMultiplier({ valueKey, tokenType, model, endpointTokenConfig, inputTokenCount }),
  );
  let rate = multiplier;
  let tokenValue = rawAmount * multiplier;
  if (txData.context === 'incomplete' && tokenType === 'completion') {
    tokenValue = Math.ceil(tokenValue * CANCEL_RATE);
    rate *= CANCEL_RATE;
  }
  return { tokenValue, rate };
}

function calculateStructuredTokenValue(
  txData: StructuredTxData,
  pricing: PricingFns,
): { tokenValue: number; rate: number; rawAmount: number; rateDetail?: Record<string, number> } {
  const { tokenType, model, endpointTokenConfig, inputTokenCount } = txData;

  if (!tokenType) {
    return { tokenValue: txData.rawAmount ?? 0, rate: 0, rawAmount: txData.rawAmount ?? 0 };
  }

  if (tokenType === 'prompt') {
    const inputMultiplier = pricing.getMultiplier({
      tokenType: 'prompt',
      model,
      endpointTokenConfig,
      inputTokenCount,
    });
    const writeMultiplier =
      pricing.getCacheMultiplier({
        cacheType: 'write',
        model,
        endpointTokenConfig,
        inputTokenCount,
      }) ?? inputMultiplier;
    const readMultiplier =
      pricing.getCacheMultiplier({
        cacheType: 'read',
        model,
        endpointTokenConfig,
        inputTokenCount,
      }) ?? inputMultiplier;

    const inputAbs = Math.abs(txData.inputTokens ?? 0);
    const writeAbs = Math.abs(txData.writeTokens ?? 0);
    const readAbs = Math.abs(txData.readTokens ?? 0);
    const totalPromptTokens = inputAbs + writeAbs + readAbs;

    const rate =
      totalPromptTokens > 0
        ? (Math.abs(inputMultiplier * (txData.inputTokens ?? 0)) +
            Math.abs(writeMultiplier * (txData.writeTokens ?? 0)) +
            Math.abs(readMultiplier * (txData.readTokens ?? 0))) /
          totalPromptTokens
        : Math.abs(inputMultiplier);

    const tokenValue = -(
      inputAbs * inputMultiplier +
      writeAbs * writeMultiplier +
      readAbs * readMultiplier
    );

    return {
      tokenValue,
      rate,
      rawAmount: -totalPromptTokens,
      rateDetail: { input: inputMultiplier, write: writeMultiplier, read: readMultiplier },
    };
  }

  const multiplier = pricing.getMultiplier({
    tokenType,
    model,
    endpointTokenConfig,
    inputTokenCount,
  });
  const rawAmount = -Math.abs(txData.rawAmount ?? 0);
  let rate = Math.abs(multiplier);
  let tokenValue = rawAmount * multiplier;

  if (txData.context === 'incomplete' && tokenType === 'completion') {
    tokenValue = Math.ceil(tokenValue * CANCEL_RATE);
    rate *= CANCEL_RATE;
  }

  return { tokenValue, rate, rawAmount };
}

function prepareStandardTx(
  _txData: StandardTxData & {
    balance?: Partial<TCustomConfig['balance']> | null;
    transactions?: Partial<TTransactionsConfig>;
  },
  pricing: PricingFns,
): PreparedEntry | null {
  const { balance, transactions, ...txData } = _txData;
  if (txData.rawAmount != null && isNaN(txData.rawAmount)) {
    return null;
  }
  if (transactions?.enabled === false) {
    return null;
  }

  const { tokenValue, rate } = calculateTokenValue(txData, pricing);
  return {
    doc: { ...txData, tokenValue, rate },
    tokenValue,
    balance,
  };
}

function prepareStructuredTx(
  _txData: StructuredTxData & {
    balance?: Partial<TCustomConfig['balance']> | null;
    transactions?: Partial<TTransactionsConfig>;
  },
  pricing: PricingFns,
): PreparedEntry | null {
  const { balance, transactions, ...txData } = _txData;
  if (transactions?.enabled === false) {
    return null;
  }

  const { tokenValue, rate, rawAmount, rateDetail } = calculateStructuredTokenValue(
    txData,
    pricing,
  );
  return {
    doc: {
      ...txData,
      tokenValue,
      rate,
      rawAmount,
      ...(rateDetail && { rateDetail }),
    },
    tokenValue,
    balance,
  };
}

export function prepareTokenSpend(
  txData: TxMetadata,
  tokenUsage: TokenUsage,
  pricing: PricingFns,
): PreparedEntry[] {
  const { promptTokens, completionTokens } = tokenUsage;
  const results: PreparedEntry[] = [];
  const normalizedPromptTokens = Math.max(promptTokens ?? 0, 0);

  if (promptTokens !== undefined) {
    const entry = prepareStandardTx(
      {
        ...txData,
        tokenType: 'prompt',
        rawAmount: promptTokens === 0 ? 0 : -normalizedPromptTokens,
        inputTokenCount: normalizedPromptTokens,
      },
      pricing,
    );
    if (entry) {
      results.push(entry);
    }
  }

  if (completionTokens !== undefined) {
    const entry = prepareStandardTx(
      {
        ...txData,
        tokenType: 'completion',
        rawAmount: completionTokens === 0 ? 0 : -Math.max(completionTokens, 0),
        inputTokenCount: normalizedPromptTokens,
      },
      pricing,
    );
    if (entry) {
      results.push(entry);
    }
  }

  return results;
}

export function prepareStructuredTokenSpend(
  txData: TxMetadata,
  tokenUsage: StructuredTokenUsage,
  pricing: PricingFns,
): PreparedEntry[] {
  const { promptTokens, completionTokens } = tokenUsage;
  const results: PreparedEntry[] = [];

  if (promptTokens) {
    const input = Math.max(promptTokens.input ?? 0, 0);
    const write = Math.max(promptTokens.write ?? 0, 0);
    const read = Math.max(promptTokens.read ?? 0, 0);
    const totalInputTokens = input + write + read;
    const entry = prepareStructuredTx(
      {
        ...txData,
        tokenType: 'prompt',
        inputTokens: -input,
        writeTokens: -write,
        readTokens: -read,
        inputTokenCount: totalInputTokens,
      },
      pricing,
    );
    if (entry) {
      results.push(entry);
    }
  }

  if (completionTokens) {
    const totalInputTokens = promptTokens
      ? Math.max(promptTokens.input ?? 0, 0) +
        Math.max(promptTokens.write ?? 0, 0) +
        Math.max(promptTokens.read ?? 0, 0)
      : undefined;
    const entry = prepareStandardTx(
      {
        ...txData,
        tokenType: 'completion',
        rawAmount: -Math.max(completionTokens, 0),
        inputTokenCount: totalInputTokens,
      },
      pricing,
    );
    if (entry) {
      results.push(entry);
    }
  }

  return results;
}

export async function bulkWriteTransactions(
  { user, docs }: { user: string; docs: PreparedEntry[] },
  dbOps: BulkWriteDeps,
): Promise<void> {
  if (!docs.length) {
    return;
  }

  let totalTokenValue = 0;
  let balanceEnabled = false;
  const plainDocs = docs.map(({ doc, tokenValue, balance }) => {
    if (balance?.enabled) {
      balanceEnabled = true;
      totalTokenValue += tokenValue;
    }
    return doc;
  });

  if (balanceEnabled) {
    await dbOps.updateBalance({ user, incrementValue: totalTokenValue });
  }

  await dbOps.insertMany(plainDocs);
}
