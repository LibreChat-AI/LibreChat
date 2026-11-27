import type { TAttachment } from 'librechat-data-provider';
import { partitionWorkspaceChanges } from '../attachments';

const change = (path: string, fields: Record<string, unknown> = {}): TAttachment =>
  ({
    filepath: `/files/${path}`,
    workspaceChange: { profile: 'stateful', operation: 'updated', path },
    ...fields,
  }) as unknown as TAttachment;

describe('partitionWorkspaceChanges', () => {
  it('separates stateful workspace files from the attachments drawn beside parts', () => {
    const image = { filepath: '/files/chart.png', toolCallId: 'call_0' } as unknown as TAttachment;
    const stateless = change('notes.md');
    (stateless as { workspaceChange: { profile: string } }).workspaceChange.profile = 'stateless';
    const unsaved = change('draft.md', { filepath: undefined });
    const saved = change('report.csv', { file_id: 'file_1' });

    expect(partitionWorkspaceChanges([image, stateless, unsaved, saved])).toEqual({
      inlineAttachments: [image, stateless, unsaved],
      workspaceChanges: [saved],
    });
    expect(partitionWorkspaceChanges()).toEqual({ inlineAttachments: [], workspaceChanges: [] });
  });

  it('keeps the latest record of a file, at the position of its latest change', () => {
    const first = change('a.md', { file_id: 'file_a', bytes: 1 });
    const other = change('b.md', { file_id: 'file_b' });
    const again = change('a.md', { file_id: 'file_a', bytes: 2 });

    expect(partitionWorkspaceChanges([first, other, again]).workspaceChanges).toEqual([
      other,
      again,
    ]);
  });

  it('tells files with no id apart by agent and path', () => {
    const mine = change('a.md', { agentId: 'agent_a' });
    const theirs = change('a.md', { agentId: 'agent_b' });
    const mineAgain = change('a.md', { agentId: 'agent_a' });

    expect(partitionWorkspaceChanges([mine, theirs, mineAgain]).workspaceChanges).toEqual([
      theirs,
      mineAgain,
    ]);
  });
});
