import { createHash } from 'node:crypto';
import type { FilterQuery } from 'mongoose';
import type {
  ResponseExecutionBinding,
  StoredResponseRecord,
  ResponseTerminalReceipt,
} from '~/models/response';

export function sameResponseTerminalReceipt(
  a: ResponseTerminalReceipt,
  b: ResponseTerminalReceipt,
): boolean {
  const fields: Record<keyof ResponseTerminalReceipt, boolean> = {
    generationCreatedAt: a.generationCreatedAt === b.generationCreatedAt,
    providerExecutionId: a.providerExecutionId === b.providerExecutionId,
    ownerId: a.ownerId === b.ownerId,
    status: a.status === b.status,
    responseJSON: a.responseJSON === b.responseJSON,
    turnJSON: a.turnJSON === b.turnJSON,
    checkpointNamespace: a.checkpointNamespace === b.checkpointNamespace,
    checkpointConfigJSON: a.checkpointConfigJSON === b.checkpointConfigJSON,
  };
  return Object.values(fields).every(Boolean);
}

export function terminalReceipt(receipt: ResponseTerminalReceipt): ResponseTerminalReceipt {
  return {
    generationCreatedAt: receipt.generationCreatedAt,
    providerExecutionId: receipt.providerExecutionId,
    ...(receipt.ownerId == null ? {} : { ownerId: receipt.ownerId }),
    status: receipt.status,
    responseJSON: receipt.responseJSON,
    ...(receipt.turnJSON == null ? {} : { turnJSON: receipt.turnJSON }),
    ...(receipt.checkpointNamespace == null
      ? {}
      : { checkpointNamespace: receipt.checkpointNamespace }),
    ...(receipt.checkpointConfigJSON == null
      ? {}
      : { checkpointConfigJSON: receipt.checkpointConfigJSON }),
  };
}

export function terminalFilter(
  prefix: string,
  receipt: ResponseTerminalReceipt,
): Record<string, unknown> {
  return {
    terminalReceiptKey: responseReceiptKey(receipt),
    [`${prefix}.generationCreatedAt`]: receipt.generationCreatedAt,
    [`${prefix}.providerExecutionId`]: receipt.providerExecutionId,
    [`${prefix}.ownerId`]: receipt.ownerId ?? { $exists: false },
  };
}

export function responseReceiptKey(receipt: ResponseTerminalReceipt): string {
  return createHash('sha256')
    .update(JSON.stringify(terminalReceipt(receipt)))
    .digest('hex');
}

export function assertResponseExecutionBinding(binding: ResponseExecutionBinding): void {
  if (
    !Number.isSafeInteger(binding.generationCreatedAt) ||
    binding.generationCreatedAt < 1 ||
    typeof binding.providerExecutionId !== 'string' ||
    !binding.providerExecutionId ||
    binding.providerExecutionId.length > 128 ||
    (binding.ownerId != null &&
      (typeof binding.ownerId !== 'string' || !binding.ownerId || binding.ownerId.length > 128))
  )
    throw new TypeError('Invalid Response provider identity');
}

/** Match only the currently running provider segment on a published physical Root. */
export function responseProviderFilter(
  binding: ResponseExecutionBinding,
): FilterQuery<StoredResponseRecord> {
  assertResponseExecutionBinding(binding);
  return {
    generationCreatedAt: binding.generationCreatedAt,
    'providerExecution.id': binding.providerExecutionId,
    'providerExecution.ownerId': binding.ownerId ?? { $exists: false },
    'providerExecution.drained': { $ne: true },
    '_managed.phase': 'published',
    retiredAt: { $exists: false },
    persistenceFailure: { $exists: false },
    cancellationRequestedAt: { $exists: false },
  };
}

/** The immutable receipt declares the complete set; canonical inputs use the managed namespace. */
export function responseTurnMessageIds(
  responseId: string,
  receipt: ResponseTerminalReceipt,
): ReadonlySet<string> {
  const turn: unknown = JSON.parse(receipt.turnJSON!);
  if (
    typeof turn !== 'object' ||
    turn === null ||
    !('version' in turn) ||
    turn.version !== 1 ||
    !('inputs' in turn) ||
    !Array.isArray(turn.inputs) ||
    !/^resp_d_[a-f\d]{32}$/.test(responseId)
  )
    throw new TypeError('Invalid Response target intent');
  const ids = new Set([responseId]);
  for (const input of turn.inputs) {
    if (
      typeof input !== 'object' ||
      input === null ||
      !('messageId' in input) ||
      typeof input.messageId !== 'string' ||
      !/^resp_d_[a-f\d]{32}$/.test(input.messageId)
    )
      throw new TypeError('Invalid Response target intent');
    ids.add(input.messageId);
  }
  return ids;
}
