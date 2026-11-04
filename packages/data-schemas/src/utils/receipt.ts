import { createHash } from 'node:crypto';
import type { ResponseTerminalReceipt } from '~/models/response';

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
  const fields: Record<
    keyof ResponseTerminalReceipt,
    ResponseTerminalReceipt[keyof ResponseTerminalReceipt]
  > = {
    generationCreatedAt: receipt.generationCreatedAt,
    providerExecutionId: receipt.providerExecutionId,
    ownerId: receipt.ownerId,
    status: receipt.status,
    responseJSON: receipt.responseJSON,
    turnJSON: receipt.turnJSON,
    checkpointNamespace: receipt.checkpointNamespace,
    checkpointConfigJSON: receipt.checkpointConfigJSON,
  };
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [`${prefix}.${key}`, value ?? { $exists: false }]),
  );
}

export function responseReceiptKey(receipt: ResponseTerminalReceipt): string {
  return createHash('sha256')
    .update(JSON.stringify(terminalReceipt(receipt)))
    .digest('hex');
}
