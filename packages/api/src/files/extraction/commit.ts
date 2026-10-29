import type { StoredUploadCleanup } from '../orphan';
import type { ExtractionLifetime } from './lifetime';
import { assertExtractionActive } from './lifetime';
import { withStoredUploadCleanup } from '../orphan';
import { ExtractionServiceError } from './client';

export interface ExtractionUploadPersistence {
  readonly selected: boolean;
  select(): void;
  assertActive(): void;
  wait<T>(pending: Promise<T>): Promise<T>;
}

/** Request-owned checkpoints remain live after extraction releases its transport listeners. */
export function createExtractionUploadPersistence(
  owner: ExtractionLifetime,
): ExtractionUploadPersistence {
  let selected = false;
  const assertActive = () => {
    if (selected) assertExtractionActive(owner);
  };
  return {
    get selected() {
      return selected;
    },
    select() {
      selected = true;
      assertActive();
    },
    assertActive,
    async wait(pending) {
      // Retention starts independently; an early cancellation must still observe its rejection.
      void pending.catch(() => undefined);
      assertActive();
      try {
        return await pending;
      } finally {
        assertActive();
      }
    },
  };
}

interface AgentResource {
  agent_id: string;
  tool_resource: string;
  file_id: string;
  updatingUserId?: string;
}

/** A resource link is staging until the file write. Confirmed/uncertain file commits keep their bytes. */
export async function commitExtractionUpload<T>({
  persistence,
  cleanup,
  resource,
  messageAttachment,
  addAgentResourceFile,
  removeAgentResourceFiles,
  createFile,
}: {
  persistence: ExtractionUploadPersistence;
  cleanup: StoredUploadCleanup;
  resource: AgentResource;
  messageAttachment: boolean;
  addAgentResourceFile: (input: AgentResource) => Promise<unknown>;
  removeAgentResourceFiles: (input: {
    agent_id: string;
    files: Array<{ tool_resource: string; file_id: string }>;
  }) => Promise<unknown>;
  createFile: () => Promise<T>;
}): Promise<T> {
  let resourceStarted = false;
  const value = await withStoredUploadCleanup(
    {
      ...cleanup,
      trackWrite: true,
      onUncommitted: async () => {
        if (persistence.selected && resourceStarted) {
          await removeAgentResourceFiles({
            agent_id: resource.agent_id,
            files: [{ tool_resource: resource.tool_resource, file_id: resource.file_id }],
          });
        }
      },
    },
    async (beginWrite) => {
      persistence.assertActive();
      if (!messageAttachment && resource.tool_resource) {
        resourceStarted = true;
        await addAgentResourceFile(resource);
        persistence.assertActive();
      }
      persistence.assertActive();
      // A dispatched record write may commit even if its acknowledgement fails. Cleanup reconciles it.
      beginWrite();
      const result = await createFile();
      if (persistence.selected && result == null)
        throw new ExtractionServiceError('PERSISTENCE_FAILED');
      return result;
    },
  );
  // The record now owns storage/retention. A late disconnect suppresses success, not durable data.
  persistence.assertActive();
  return value;
}
