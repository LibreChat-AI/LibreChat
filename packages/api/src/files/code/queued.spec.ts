import { FileContext } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { CodeFileAgent } from './queued';
import { planCodeFileUploads, prepareQueuedCodeFileContext } from './queued';

function file(id: string, overrides: Partial<TFile> = {}): TFile {
  return {
    file_id: id,
    filename: 'data.csv',
    filepath: '/uploads/data.csv',
    type: 'text/csv',
    user: 'user-1',
    object: 'file',
    bytes: 10,
    embedded: false,
    usage: 0,
    context: FileContext.message_attachment,
    ...overrides,
  };
}

function agent(id: string, files: TFile[]): CodeFileAgent {
  return {
    id,
    fileConsumers: { executeCode: true, fileSearch: false },
    provisionState: {
      codeEnvFiles: files,
      vectorDBFiles: [],
      aliveFileIds: new Set(),
      agentScopedFileIds: new Set(),
    },
    dynamicToolContextMap: {},
  };
}

describe('queued code-file destinations', () => {
  it('keeps an advertised shared path when a lazy agent adds a newer colliding input', () => {
    const shared = file('shared', { createdAt: '2026-09-01' });
    const parent = agent('parent', [{ ...shared }]);
    prepareQueuedCodeFileContext(parent, [parent], 'user-1');
    const advertised = parent.provisionState?.codeEnvDestinations?.get('shared');
    const child = agent('child', [{ ...shared }, file('new', { createdAt: '2026-10-01' })]);
    prepareQueuedCodeFileContext(child, [parent, child], 'user-1', true);

    expect(child.provisionState?.codeEnvDestinations?.get('shared')).toBe(advertised);
    expect(child.provisionState?.codeEnvDestinations?.get('new')).not.toBe(advertised);
    expect(
      planCodeFileUploads({
        context: child,
        contexts: [parent, child],
        agentId: child.id,
        userId: 'user-1',
        useAdvertisedNames: true,
      }).find((upload) => upload.file.file_id === 'shared')?.destination,
    ).toBe(advertised);
  });

  it('does not move a confirmed live path when another agent also queues that file', () => {
    const shared = file('shared', {
      createdAt: '2026-09-01',
      metadata: {
        codeEnvRefs: {
          default: {
            kind: 'user',
            id: 'user-1',
            storage_session_id: 'session',
            file_id: 'remote',
            sandboxFilename: 'data.csv',
          },
        },
      },
    });
    const parent = agent('parent', [file('new', { createdAt: '2026-10-01' })]);
    parent.tool_resources = { execute_code: { files: [shared] } };
    const child = agent('child', [{ ...shared }, file('new', { createdAt: '2026-10-01' })]);
    for (const current of [parent, child]) {
      prepareQueuedCodeFileContext(current, [parent, child], 'user-1');
    }

    expect(parent.provisionState?.codeEnvDestinations?.get('new')).not.toBe('data.csv');
    expect(child.provisionState?.codeEnvDestinations?.get('shared')).toBe('data.csv');
  });

  it('retains advertised paths after one file succeeds and another remains queued', () => {
    const current = agent('parent', [file('first'), file('second')]);
    prepareQueuedCodeFileContext(current, [current], 'user-1');
    const advertised = new Map(current.provisionState?.codeEnvDestinations);
    current.provisionState!.codeEnvFiles = [file('second')];
    current.pendingProvisionedCodeFiles = [
      {
        id: 'remote-first',
        name: advertised.get('first')!,
        storage_session_id: 'session',
        resource_id: 'user-1',
        kind: 'user',
      },
    ];
    prepareQueuedCodeFileContext(current, [current], 'user-1');

    expect(current.provisionState?.codeEnvDestinations?.get('second')).toBe(
      advertised.get('second'),
    );
  });
});
