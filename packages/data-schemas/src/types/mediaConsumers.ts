import type { MediaOwnerScope } from './media';

export type MediaConsumerConfig = {
  maxAssetRetainers: number;
  consumerClaimMs: number;
  consumerReconcileMs: number;
};

type MediaConsumerTarget =
  | { conversationId: string; presetId?: never }
  | { presetId: string; conversationId?: never };

export type MediaConsumerClaim = MediaConsumerTarget & {
  token: string;
  expiresAt: Date;
};

export type MediaFileConsumerWrite = MediaConsumerTarget & {
  scope: MediaOwnerScope;
  fileIds: string[];
  token: string;
  config: MediaConsumerConfig;
};

export interface MediaFileConsumerMethods {
  acquireMediaFileConsumers(input: MediaFileConsumerWrite): Promise<void>;
  confirmMediaFileConsumers(input: MediaFileConsumerWrite): Promise<void>;
  releaseMediaFileConsumerClaims(input: MediaFileConsumerWrite): Promise<void>;
  reconcileMediaFileConsumers(input: {
    scope: MediaOwnerScope;
    limit: number;
    cursor?: string;
    conversationId?: string;
    presetId?: string;
    now?: string;
    retryMs?: number;
  }): Promise<{ inspected: number; nextCursor?: string }>;
}
