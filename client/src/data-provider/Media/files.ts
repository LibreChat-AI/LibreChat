import { QueryKeys } from 'librechat-data-provider';
import type { MediaAsset, MediaTurn, TFile } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import { addFilesToCache } from '~/utils/files';

/** Media DTOs omit identity; the authenticated host supplies it at the Files cache boundary. */
export function cacheMediaAssets(
  client: QueryClient,
  userId: string | undefined,
  assets: MediaAsset[],
) {
  if (!userId || !assets.length) return;
  const previous = new Map(
    client.getQueryData<TFile[]>([QueryKeys.files])?.map((file) => [file.file_id, file]),
  );
  const files: TFile[] = assets.map((asset) => {
    const file: TFile = {
      object: 'file',
      embedded: false,
      usage: 0,
      ...previous.get(asset.file_id),
      ...asset,
      user: userId,
    };
    previous.set(asset.file_id, file);
    return file;
  });
  addFilesToCache(client, files);
}

export function cacheMediaTurns(
  client: QueryClient,
  userId: string | undefined,
  turns: MediaTurn[],
  contextAssets: MediaAsset[] = [],
) {
  const assets: MediaAsset[] = [];
  for (const turn of turns) {
    assets.push(...turn.assets);
    for (const job of turn.jobs)
      for (const output of job.outputs)
        if (output.kind !== 'text' && output.state === 'ready' && output.asset)
          assets.push(output.asset);
  }
  for (const asset of contextAssets) {
    if (assets.some((previous) => previous.file_id === asset.file_id)) assets.push(asset);
    else assets.unshift(asset);
  }
  cacheMediaAssets(client, userId, assets);
}
