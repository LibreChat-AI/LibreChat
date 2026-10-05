import type { MediaPreset, MediaPresetUpdate, MediaPresetWrite } from 'librechat-data-provider';
import type { MediaConsumerConfig } from './mediaConsumers';
import type { MediaOwnerScope } from './media';

export type MediaStoredPreset = Omit<MediaPreset, 'createdAt' | 'updatedAt' | 'assets'> &
  MediaOwnerScope & { version: number; createdAt: Date; updatedAt: Date };

export interface MediaPresetMethods {
  ensureMediaPresetIndexes(): Promise<void>;
  /** Default presets sort first, then titles ascending. */
  listMediaPresets(scope: MediaOwnerScope): Promise<MediaPreset[]>;
  createMediaPreset(input: {
    scope: MediaOwnerScope;
    presetId: string;
    write: MediaPresetWrite;
    maxPresets: number;
    maxInputs?: number;
    consumerConfig?: MediaConsumerConfig;
  }): Promise<MediaPreset>;
  updateMediaPreset(input: {
    scope: MediaOwnerScope;
    presetId: string;
    update: MediaPresetUpdate;
    maxInputs?: number;
    consumerConfig?: MediaConsumerConfig;
  }): Promise<MediaPreset | null>;
  deleteMediaPreset(
    scope: MediaOwnerScope,
    presetId: string,
    consumerConfig?: MediaConsumerConfig,
  ): Promise<boolean>;
}
