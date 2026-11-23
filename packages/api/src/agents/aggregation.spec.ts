import { Constants, ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { SubagentBuffer } from './aggregation';
import { attachSubagentContent } from './aggregation';

type Call = {
  id: string;
  name: string;
  subagentIdentity?: SubagentBuffer['subagentIdentity'];
  subagent_content?: TMessageContentParts[];
};

const call = (id: string, name: string = Constants.SUBAGENT) =>
  ({ type: ContentTypes.TOOL_CALL, tool_call: { id, name } }) as unknown as TMessageContentParts;
const text = (value: string) =>
  ({ type: ContentTypes.TEXT, text: value }) as unknown as TMessageContentParts;
const callOf = (part: TMessageContentParts | undefined) =>
  (part as unknown as { tool_call: Call }).tool_call;
const buffer = (
  parts: (TMessageContentParts | undefined)[],
  subagentAgentId?: string,
): SubagentBuffer => ({
  contentParts: parts as SubagentBuffer['contentParts'],
  ...(subagentAgentId && { subagentIdentity: { subagentKind: 'agent', subagentAgentId } }),
});

describe('attachSubagentContent', () => {
  it('attaches a child to the call that started it and leaves other calls alone', () => {
    const content = [call('other'), call('outer'), call('outer', 'calculator')];
    const buffers = new Map([['outer', buffer([text('child answer')], 'agent_child')]]);

    attachSubagentContent(content, buffers);

    expect(callOf(content[0]).subagent_content).toBeUndefined();
    expect(callOf(content[1])).toMatchObject({
      subagentIdentity: { subagentKind: 'agent', subagentAgentId: 'agent_child' },
      subagent_content: [text('child answer')],
    });
    expect(callOf(content[2]).subagent_content).toBeUndefined();
    expect(buffers.size).toBe(0);
  });

  it('attaches a child to a call made from inside another child, at any depth', () => {
    const content = [call('outer')];
    const buffers = new Map([
      ['deepest', buffer([text('grandchild answer')], 'agent_grandchild')],
      ['inner', buffer([call('deepest'), text('child answer')], 'agent_child')],
      ['outer', buffer([call('inner'), text('copy answer')], 'agent_parent')],
    ]);

    attachSubagentContent(content, buffers);

    const inner = callOf(callOf(content[0]).subagent_content?.[0]);
    expect(inner.subagentIdentity).toEqual({
      subagentKind: 'agent',
      subagentAgentId: 'agent_child',
    });
    const deepest = callOf(inner.subagent_content?.[0]);
    expect(deepest).toMatchObject({
      subagentIdentity: { subagentKind: 'agent', subagentAgentId: 'agent_grandchild' },
      subagent_content: [text('grandchild answer')],
    });
    expect(buffers.size).toBe(0);
  });

  it('keeps identity for a child that produced no content and drops the holes of one that did', () => {
    const content = [call('silent'), call('sparse')];
    const buffers = new Map([
      ['silent', buffer([], 'agent_silent')],
      ['sparse', buffer([undefined, text('kept'), undefined])],
    ]);

    attachSubagentContent(content, buffers);

    expect(callOf(content[0]).subagentIdentity?.subagentAgentId).toBe('agent_silent');
    expect(callOf(content[0]).subagent_content).toBeUndefined();
    expect(callOf(content[1]).subagent_content).toEqual([text('kept')]);
  });

  it('attaches a buffer once when a transcript names its own call, and drops what has no call', () => {
    const content = [call('outer')];
    const buffers = new Map([
      ['outer', buffer([call('outer'), text('answer')], 'agent_parent')],
      ['orphan', buffer([text('nobody called me')])],
    ]);

    attachSubagentContent(content, buffers);

    const repeated = callOf(callOf(content[0]).subagent_content?.[0]);
    expect(repeated.subagent_content).toBeUndefined();
    expect(buffers.size).toBe(0);
  });

  it('reports a child it could not attach and goes on to the next', () => {
    const content = [call('broken'), call('fine')];
    const broken = {
      get contentParts(): SubagentBuffer['contentParts'] {
        throw new Error('unreadable');
      },
    } as SubagentBuffer;
    const buffers = new Map([
      ['broken', broken],
      ['fine', buffer([text('answer')])],
    ]);
    const failed: string[] = [];

    attachSubagentContent(content, buffers, (id) => failed.push(id));

    expect(failed).toEqual(['broken']);
    expect(callOf(content[1]).subagent_content).toEqual([text('answer')]);
  });

  it('does nothing without content or buffers', () => {
    const buffers = new Map([['outer', buffer([text('answer')])]]);
    attachSubagentContent(undefined, buffers);
    expect(buffers.size).toBe(1);
    expect(() => attachSubagentContent([call('outer')], undefined)).not.toThrow();
  });
});
