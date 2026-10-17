import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import {
  collectNestedCalls,
  assignNestedAttachments,
  selectUnclaimedAttachments,
  selectExactlyNestedAttachments,
} from './attachments';

const file = (toolCallId?: string) =>
  ({ file_id: `file-${toolCallId}`, toolCallId }) as TAttachment;

const toolCall = (id: string, fields: Record<string, unknown> = {}) =>
  ({ type: 'tool_call', tool_call: { id, ...fields } }) as unknown as TMessageContentParts;

const subagent = (id: string, subagent_content: TMessageContentParts[]) =>
  toolCall(id, { name: 'subagent', subagent_content });

const ids = (map: ReadonlyMap<unknown, TAttachment[]>, owner: TMessageContentParts) =>
  (map.get(owner) ?? []).map((attachment) => attachment.toolCallId);

describe('subagent attachments', () => {
  it('leaves out files a top-level part accepted and files without a tool call', () => {
    const accepted = file('direct-call');
    const unclaimed = selectUnclaimedAttachments(
      [accepted, file('child-call'), file(undefined)],
      new Set([accepted]),
    );
    expect(unclaimed.map((attachment) => attachment.toolCallId)).toEqual(['child-call']);
  });

  it('offers a file its top-level part rejected to the subagent that ran it', () => {
    const rejected = file('shared-id');
    const unclaimed = selectUnclaimedAttachments([rejected], new Set());
    const content = [subagent('subagent-call', [toolCall('shared-id')]), toolCall('shared-id')];
    expect(ids(assignNestedAttachments(content, unclaimed, new Map()), content[0])).toEqual([
      'shared-id',
    ]);
  });

  it('collects child calls with their scope through nested runs and previews', () => {
    const scoped = {
      type: 'tool_call',
      agentId: 'agent-child',
      tool_call: { id: 'grandchild-call', stepId: 'step-1' },
    } as unknown as TMessageContentParts;
    expect(
      collectNestedCalls([
        subagent('child-call', [scoped]),
        toolCall('previewed-call', {
          subagentAttachmentCalls: [{ id: 'omitted-call', stepId: 'step-2' }],
        }),
      ]),
    ).toEqual([
      { id: 'child-call' },
      { id: 'grandchild-call', agentId: 'agent-child', stepId: 'step-1' },
      { id: 'previewed-call' },
      { id: 'omitted-call', stepId: 'step-2' },
    ]);
  });

  it('keeps a previewed scope apart when two subagents share a child id', () => {
    const content = [
      toolCall('first', { subagentAttachmentCalls: [{ id: 'shared', stepId: 'step-a' }] }),
      toolCall('second', { subagentAttachmentCalls: [{ id: 'shared', stepId: 'step-b' }] }),
    ];
    const fromB = { ...file('shared'), stepId: 'step-b' } as TAttachment;
    const assigned = assignNestedAttachments(content, [fromB], new Map());
    expect(ids(assigned, content[0])).toEqual([]);
    expect(ids(assigned, content[1])).toEqual(['shared']);
  });

  it('routes previewed, live and stored child files, each to one owner', () => {
    const content = [
      subagent('first', [toolCall('shared-child')]),
      subagent('second', [toolCall('shared-child')]),
      toolCall('previewed', { name: 'subagent', subagentAttachmentCalls: [{ id: 'omitted' }] }),
      toolCall('streaming', { name: 'subagent' }),
    ];
    const unclaimed = [file('shared-child'), file('omitted'), file('live-child'), file('other')];
    const assigned = assignNestedAttachments(
      content,
      unclaimed,
      new Map([[3, [{ id: 'live-child' }]]]),
    );
    expect(ids(assigned, content[0])).toEqual(['shared-child']);
    expect(ids(assigned, content[1])).toEqual([]);
    expect(ids(assigned, content[2])).toEqual(['omitted']);
    expect(ids(assigned, content[3])).toEqual(['live-child']);
  });

  it('gives a child id two subagents share to the run whose step saved the file', () => {
    const content = [
      subagent('first', [toolCall('shared-child', { stepId: 'step-a' })]),
      subagent('second', [toolCall('shared-child', { stepId: 'step-b' })]),
    ];
    const fromB = { ...file('shared-child'), stepId: 'step-b' } as TAttachment;
    const assigned = assignNestedAttachments(content, [fromB], new Map());
    expect(ids(assigned, content[0])).toEqual([]);
    expect(ids(assigned, content[1])).toEqual(['shared-child']);
  });

  it('prefers the run whose call carries the file scope over one whose scope is unknown', () => {
    const content = [
      subagent('first', [toolCall('shared-child')]),
      subagent('second', [toolCall('shared-child', { stepId: 'step-b' })]),
    ];
    const fromB = { ...file('shared-child'), stepId: 'step-b' } as TAttachment;
    const unscoped = file('shared-child');
    const assigned = assignNestedAttachments(content, [fromB, unscoped], new Map());
    expect(assigned.get(content[0])).toEqual([unscoped]);
    expect(assigned.get(content[1])).toEqual([fromB]);
  });

  it('routes child files of a stored subagent call that has no id', () => {
    const legacy = {
      type: 'tool_call',
      tool_call: { name: 'subagent', subagent_content: [toolCall('legacy-child')] },
    } as unknown as TMessageContentParts;
    const assigned = assignNestedAttachments([legacy], [file('legacy-child')], new Map());
    expect(ids(assigned, legacy)).toEqual(['legacy-child']);
  });

  it('reads a child call owner stored on the call when the part has none', () => {
    expect(collectNestedCalls([toolCall('child', { agentId: 'agent-on-call' })])).toEqual([
      { id: 'child', agentId: 'agent-on-call' },
    ]);
  });

  it('reserves a file a child call owns under its full scope', () => {
    const content = [subagent('runner', [toolCall('reused', { stepId: 'step-child' })])];
    const scoped = { ...file('reused'), stepId: 'step-child' } as TAttachment;
    const other = { ...file('reused'), stepId: 'step-other' } as TAttachment;
    expect(selectExactlyNestedAttachments(content, [scoped, other], new Map())).toEqual(
      new Set([scoped]),
    );
  });

  it('collects child calls of a chain nested thousands deep', () => {
    let deepest = toolCall('deepest-call');
    for (let depth = 0; depth < 10_000; depth++) {
      deepest = subagent(`level-${depth}`, [deepest]);
    }
    const calls = collectNestedCalls([deepest]);
    expect(calls).toHaveLength(10_001);
    expect(calls.at(-1)).toEqual({ id: 'deepest-call' });
  });

  it('uses the run owner for its own top-level calls only', () => {
    expect(
      collectNestedCalls(
        [toolCall('own-call'), subagent('nested-run', [toolCall('nested-call')])],
        [],
        'run-agent',
      ),
    ).toEqual([
      { id: 'own-call', agentId: 'run-agent' },
      { id: 'nested-run', agentId: 'run-agent' },
      { id: 'nested-call' },
    ]);
  });

  it('gives restored child files to the run whose stored identity owns them', () => {
    const run = (id: string, agent: string) =>
      toolCall(id, {
        name: 'subagent',
        subagentIdentity: { subagentKind: 'agent', subagentAgentId: agent },
        subagent_content: [toolCall('shared-child')],
      });
    const content = [run('first', 'agent-a'), run('second', 'agent-b')];
    const fromB = { ...file('shared-child'), agentId: 'agent-b' } as TAttachment;
    const assigned = assignNestedAttachments(content, [fromB], new Map());
    expect(ids(assigned, content[0])).toEqual([]);
    expect(ids(assigned, content[1])).toEqual(['shared-child']);
  });

  it('keeps the files of two subagent calls that share an id apart', () => {
    const content = [
      subagent('same-id', [toolCall('first-child')]),
      subagent('same-id', [toolCall('second-child')]),
    ];
    const assigned = assignNestedAttachments(
      content,
      [file('first-child'), file('second-child')],
      new Map(),
    );
    expect(ids(assigned, content[0])).toEqual(['first-child']);
    expect(ids(assigned, content[1])).toEqual(['second-child']);
  });
});
