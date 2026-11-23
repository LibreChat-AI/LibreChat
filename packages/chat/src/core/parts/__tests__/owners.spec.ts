import { ContentTypes, Tools } from 'librechat-data-provider';
import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import {
  partStepId,
  partAgentId,
  isFileOutput,
  carriesScopeOf,
  partToolCallId,
  siblingStepIds,
  attachmentScopes,
  toolCallStepOwners,
  acceptedAttachments,
  collectMessageContent,
  collectPartAttachments,
  collectClaimedAttachments,
} from '../owners';
import { mapAttachments } from '../../attachments';

type Scope = { agentId?: string; stepId?: string };

const call = (id: string, scope: Scope = {}): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { id, name: 'execute_code', args: '{}', ...scope },
  }) as unknown as TMessageContentParts;

const text = (value: string): TMessageContentParts =>
  ({ type: ContentTypes.TEXT, text: value }) as TMessageContentParts;

const steer = (): TMessageContentParts =>
  ({
    type: ContentTypes.STEER,
    [ContentTypes.STEER]: 'look here',
  }) as unknown as TMessageContentParts;

const handoff = (agentId: string): TMessageContentParts =>
  ({
    type: ContentTypes.AGENT_UPDATE,
    [ContentTypes.AGENT_UPDATE]: { agentId },
  }) as unknown as TMessageContentParts;

const file = (toolCallId: string, name: string, scope: Scope = {}): TAttachment =>
  ({
    toolCallId,
    file_id: name,
    filename: name,
    filepath: `/files/${name}`,
    ...scope,
  }) as unknown as TAttachment;

const app = (
  toolCallId: string,
  uri: string,
  mimeType = 'text/html;profile=mcp-app',
): TAttachment =>
  ({
    toolCallId,
    type: Tools.ui_resources,
    [Tools.ui_resources]: [{ uri, mimeType, toolName: 'show', serverName: 'server' }],
  }) as unknown as TAttachment;

const NONE = { get: () => undefined };

describe('part scope', () => {
  it('reads the call id, agent and step from the tool call a part holds', () => {
    const part = call('call_1', { agentId: 'agent_a', stepId: 'step_1' });
    expect(partToolCallId(part)).toBe('call_1');
    expect(partAgentId(part)).toBe('agent_a');
    expect(partStepId(part)).toBe('step_1');
  });

  it('prefers the agent on the part over the one on its call, and reads nothing from text', () => {
    const part = {
      ...call('call_1', { agentId: 'inner' }),
      agentId: 'outer',
    } as TMessageContentParts;
    expect(partAgentId(part)).toBe('outer');
    expect(partToolCallId(text('hi'))).toBe('');
    expect(partAgentId(text('hi'))).toBeUndefined();
    expect(partStepId(text('hi'))).toBeUndefined();
  });
});

describe('toolCallStepOwners', () => {
  it('lists every finished step under the provider id it ran, skipping holes and live calls', () => {
    const owners = toolCallStepOwners([
      call('call_0', { stepId: 'step_1', agentId: 'agent_a' }),
      undefined,
      call('call_0'),
      call('call_0', { stepId: 'step_2' }),
      text('done'),
    ]);
    expect([...owners.keys()]).toEqual(['call_0']);
    expect(owners.get('call_0')).toEqual([
      { stepId: 'step_1', agentId: 'agent_a' },
      { stepId: 'step_2', agentId: undefined },
    ]);
  });
});

describe('siblingStepIds', () => {
  const owners = toolCallStepOwners([
    call('call_0', { stepId: 'step_a', agentId: 'agent_a' }),
    call('call_0', { stepId: 'step_b', agentId: 'agent_b' }),
    call('call_0', { stepId: 'step_any' }),
  ]);

  it('gives a live call the steps its finished siblings own', () => {
    expect([...(siblingStepIds(call('call_0'), owners) ?? [])]).toEqual([
      'step_a',
      'step_b',
      'step_any',
    ]);
  });

  it('counts only the same agent, and an owner with no agent, for a call that names its agent', () => {
    expect([...(siblingStepIds(call('call_0', { agentId: 'agent_a' }), owners) ?? [])]).toEqual([
      'step_a',
      'step_any',
    ]);
  });

  it('gives nothing to a finished call, an id no step ran, or a part with no call', () => {
    expect(siblingStepIds(call('call_0', { stepId: 'step_a' }), owners)).toBeUndefined();
    expect(siblingStepIds(call('call_9'), owners)).toBeUndefined();
    expect(siblingStepIds(text('hi'), owners)).toBeUndefined();
  });
});

describe('acceptedAttachments', () => {
  it('keeps an earlier step’s file off the live call that reuses its id', () => {
    const finished = call('call_0', { stepId: 'step_1' });
    const live = call('call_0');
    const owners = toolCallStepOwners([finished, live]);
    const old = file('call_0', 'old.png', { stepId: 'step_1' });
    const fresh = file('call_0', 'fresh.png');
    const byToolCall = mapAttachments([old, fresh]);

    expect(acceptedAttachments(finished, byToolCall, owners)).toEqual([old, fresh]);
    expect(acceptedAttachments(live, byToolCall, owners)).toEqual([fresh]);
    expect(acceptedAttachments(text('hi'), byToolCall, owners)).toBeUndefined();
  });
});

describe('collectClaimedAttachments', () => {
  it('marks a file exact only when the part carries its full scope', () => {
    const scoped = file('call_0', 'scoped.png', { agentId: 'agent_a', stepId: 'step_1' });
    const loose = file('call_1', 'loose.png');
    const content = [call('call_0'), call('call_1')];
    const { claimed, exact } = collectClaimedAttachments(
      content,
      mapAttachments([scoped, loose]),
      toolCallStepOwners(content),
      new Set(),
    );
    expect(carriesScopeOf(content[0], scoped)).toBe(false);
    expect([...claimed]).toEqual([scoped, loose]);
    expect([...exact]).toEqual([loose]);
  });

  it('leaves a reserved file to its nested owner unless a part carries the same scope', () => {
    const reserved = file('call_0', 'child.png', { agentId: 'agent_a' });
    const byToolCall = mapAttachments([reserved]);
    const unscoped = [call('call_0')];
    const scoped = [call('call_0', { agentId: 'agent_a' })];

    expect(
      collectClaimedAttachments(
        unscoped,
        byToolCall,
        toolCallStepOwners(unscoped),
        new Set([reserved]),
      ).claimed.size,
    ).toBe(0);
    expect([
      ...collectClaimedAttachments(
        scoped,
        byToolCall,
        toolCallStepOwners(scoped),
        new Set([reserved]),
      ).claimed,
    ]).toEqual([reserved]);
  });
});

describe('collectMessageContent', () => {
  it('finds each MCP App once, at the part that owns it, and ignores other attachments', () => {
    const first = app('call_0', 'ui://first');
    const nested = app('child_0', 'ui://nested');
    const plain = app('call_0', 'ui://plain', 'text/html');
    const content = [text('intro'), call('call_0'), call('subagent_0')];
    const scan = collectMessageContent(
      content,
      mapAttachments([first, plain, file('call_0', 'out.csv')]),
      toolCallStepOwners(content),
      new Map([[content[2], [nested, first]]]),
    );
    expect(scan.attachments).toEqual([first, nested]);
    expect([...scan.atIndex]).toEqual([
      [1, [first]],
      [2, [nested]],
    ]);
  });

  it('names who resumes after a steer, by transcript index', () => {
    const content = [
      handoff('agent_b'),
      text('working'),
      steer(),
      text('resumed'),
      steer(),
      handoff('agent_c'),
    ];
    const local = collectMessageContent(content, {}, new Map(), NONE);
    expect([...local.resumeAuthors]).toEqual([
      [3, 'agent_b'],
      [5, 'agent_b'],
    ]);

    const offset = collectMessageContent(content, {}, new Map(), NONE, 10);
    expect([...offset.resumeAuthors.keys()]).toEqual([13, 15]);

    const sparse = collectMessageContent(content, {}, new Map(), NONE, 10, [0, 2, 4, 8, 16, 32]);
    expect([...sparse.resumeAuthors.keys()]).toEqual([8, 32]);
  });

  it('attributes a resume with no handoff before it to the response author', () => {
    const scan = collectMessageContent([steer(), text('resumed')], {}, new Map(), NONE);
    expect([...scan.resumeAuthors]).toEqual([[1, undefined]]);
  });
});

describe('collectPartAttachments', () => {
  it('replaces an earlier record of a file in place and keeps files with no identity apart', () => {
    const first = file('call_0', 'report.csv');
    const other = file('call_0', 'chart.png');
    const latest = { ...file('call_0', 'report.csv'), bytes: 2 } as TAttachment;
    const anonymous = { toolCallId: 'call_1' } as unknown as TAttachment;
    const parts = [call('call_0'), undefined, call('call_1')];
    const files = new Map<TMessageContentParts | undefined, TAttachment[]>([
      [parts[0], [first, other, latest]],
      [parts[2], [anonymous, anonymous]],
    ]);

    expect(collectPartAttachments(parts, (part) => files.get(part))).toEqual([
      latest,
      other,
      anonymous,
      anonymous,
    ]);
    expect(collectPartAttachments([text('hi')], () => undefined)).toBeUndefined();
  });
});

describe('isFileOutput', () => {
  it('is a stored file that is neither an MCP App nor search results', () => {
    expect(isFileOutput(file('call_0', 'out.csv'))).toBe(true);
    expect(isFileOutput({ toolCallId: 'call_0' } as unknown as TAttachment)).toBe(false);
    expect(isFileOutput({ ...file('call_0', 'a'), type: Tools.ui_resources } as TAttachment)).toBe(
      false,
    );
    expect(isFileOutput({ ...file('call_0', 'a'), type: Tools.web_search } as TAttachment)).toBe(
      false,
    );
  });
});

describe('attachmentScopes', () => {
  it('lists each distinct scope once, in an order that does not depend on the input', () => {
    const a = file('call_b', 'a.png', { agentId: 'agent_a' });
    const b = file('call_a', 'b.png', { stepId: 'step_1' });
    const c = file('call_b', 'c.png', { agentId: 'agent_a' });
    const expected = [
      { toolCallId: 'call_a', stepId: 'step_1' },
      { toolCallId: 'call_b', agentId: 'agent_a' },
    ];
    expect(attachmentScopes([a, b, c])).toEqual(expected);
    expect(attachmentScopes([c, b, a])).toEqual(expected);
    expect(attachmentScopes([])).toEqual([]);
  });
});
