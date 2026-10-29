import { FileSources } from 'librechat-data-provider';
import type { AppConfig, ChannelRunRecord, RunArtifactFile } from '@librechat/data-schemas';
import type { Readable } from 'node:stream';
import { resolveDownloadPath } from '~/storage/path';

/** Only the request fields used by supported storage readers, never an authenticated HTTP request. */
export interface ChannelArtifactStorageRequest {
  config: AppConfig;
  user: { id: string };
  tenantId: string;
}

export interface ChannelArtifactStorageDependencies {
  getConfig: (run: ChannelRunRecord) => Promise<AppConfig | undefined>;
  getStrategyFunctions: (source: FileSources) =>
    | {
        getDownloadStream?: (
          request: ChannelArtifactStorageRequest,
          path: string,
          options: { signal: AbortSignal },
        ) => Promise<Readable>;
      }
    | undefined;
}

export interface ChannelArtifactReader {
  readFile: (
    file: RunArtifactFile,
    run: ChannelRunRecord,
    signal: AbortSignal,
  ) => Promise<Readable | null>;
}

const supportedSources = new Set<string>([
  FileSources.local,
  FileSources.s3,
  FileSources.cloudfront,
  FileSources.azure_blob,
  FileSources.firebase,
]);

/** Input files must already be authorized by listRunArtifacts for the exact saved response. */
export function createChannelArtifactReader(
  deps: ChannelArtifactStorageDependencies,
): ChannelArtifactReader {
  return {
    async readFile(file, run, signal) {
      const expiresAt = file.expiredAt == null ? undefined : new Date(file.expiredAt).getTime();
      if (
        !run.execution ||
        file.user !== run.principal.userId ||
        (file.tenantId ?? '_') !== run.tenantId ||
        file.conversationId !== run.execution.conversationId ||
        (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) ||
        !file.source ||
        !supportedSources.has(file.source)
      ) {
        return null;
      }
      signal.throwIfAborted();
      const path = resolveDownloadPath(file);
      if (!path) return null;
      const config = await deps.getConfig(run);
      signal.throwIfAborted();
      if (!config) return null;
      const strategy = deps.getStrategyFunctions(file.source);
      if (!strategy?.getDownloadStream) return null;
      return strategy.getDownloadStream(
        { config, user: { id: run.principal.userId }, tenantId: run.tenantId },
        path,
        { signal },
      );
    },
  };
}
