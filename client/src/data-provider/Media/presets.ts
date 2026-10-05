import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  dataService,
  QueryKeys,
  mediaPresetSchema,
  mediaPresetListSchema,
} from 'librechat-data-provider';
import type {
  MediaPreset,
  MediaPresetUpdate,
  MediaPresetWriteInput,
} from 'librechat-data-provider';
import type { MediaQueryScope } from './queries';

type PresetScope = Pick<MediaQueryScope, 'scope' | 'isCurrentSession'>;
const presetsKey = (scope: string) => [QueryKeys.mediaPresets, scope];

export function useMediaPresets(host: PresetScope, enabled = true) {
  return useQuery(
    presetsKey(host.scope),
    async ({ signal }): Promise<MediaPreset[]> => {
      const page = mediaPresetListSchema.parse(await dataService.listMediaPresets(signal));
      if (!host.isCurrentSession()) throw new Error('Session ended');
      return page.items;
    },
    { enabled, retry: false, staleTime: 60_000 },
  );
}

export function useMediaPresetMutations(host: PresetScope) {
  const client = useQueryClient();
  const settle = () => client.invalidateQueries(presetsKey(host.scope));
  const create = useMutation(
    async (write: MediaPresetWriteInput) =>
      mediaPresetSchema.parse(await dataService.createMediaPreset(write)),
    { onSuccess: settle },
  );
  const update = useMutation(
    async (input: { presetId: string; update: MediaPresetUpdate }) =>
      mediaPresetSchema.parse(await dataService.updateMediaPreset(input.presetId, input.update)),
    { onSuccess: settle },
  );
  const remove = useMutation((presetId: string) => dataService.deleteMediaPreset(presetId), {
    onSuccess: settle,
  });
  return { create, update, remove };
}
