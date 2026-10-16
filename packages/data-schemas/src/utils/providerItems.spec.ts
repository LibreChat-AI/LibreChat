import { splitProviderItems, thinkReplayHash, MAX_THINK_REPLAY_CHARS } from './providerItems';

const items = { origin: 'digest', items: [{ id: 'rs_1', encrypted_content: 'opaque' }] };

describe('splitProviderItems', () => {
  it('moves the items of each tool call out of the content, keyed by tool call id', () => {
    const content = [
      { type: 'text', text: 'hi' },
      {
        type: 'tool_call',
        agentId: 'a',
        tool_call: { id: 'call_1', name: 'lookup', providerItems: items },
      },
      { type: 'tool_call', tool_call: { id: 'call_2', name: 'other' } },
    ];
    const split = splitProviderItems(content);
    expect(split?.providerItems).toEqual({ call_1: items });
    expect(split?.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_call', agentId: 'a', tool_call: { id: 'call_1', name: 'lookup' } },
      { type: 'tool_call', tool_call: { id: 'call_2', name: 'other' } },
    ]);
    expect(content[1].tool_call).toHaveProperty('providerItems');
  });

  it('returns nothing when no part carries items, or the content is not a list', () => {
    expect(
      splitProviderItems([{ type: 'tool_call', tool_call: { id: 'call_1' } }]),
    ).toBeUndefined();
    expect(splitProviderItems('text')).toBeUndefined();
    expect(splitProviderItems(undefined)).toBeUndefined();
    expect(splitProviderItems([null])).toBeUndefined();
  });

  it('drops items of a tool call without an id instead of keeping them in the content', () => {
    const split = splitProviderItems([{ type: 'tool_call', tool_call: { providerItems: items } }]);
    expect(split).toEqual({ content: [{ type: 'tool_call', tool_call: {} }], providerItems: {} });
  });
});

describe('splitProviderItems with signed reasoning', () => {
  const replay = {
    anthropic: {
      model: 'claude-test',
      blocks: [{ type: 'thinking', thinking: '', signature: 'SIG' }],
    },
  };

  it('moves the replay of each think part out of the content, keyed by index, with a hash of its text', () => {
    const content = [
      { type: 'think', think: 'first', provider_replay: replay },
      { type: 'text', text: 'hi' },
      { type: 'tool_call', tool_call: { id: 'call_1', providerItems: items } },
      { type: 'think', think: '', provider_replay: replay },
    ];
    const split = splitProviderItems(content);
    expect(split?.providerItems).toEqual({
      'think:0': { hash: thinkReplayHash('first'), replay },
      call_1: items,
      'think:3': { hash: thinkReplayHash(''), replay },
    });
    expect(JSON.stringify(split?.content)).not.toContain('SIG');
    expect(split?.content[0]).toEqual({ type: 'think', think: 'first' });
    expect(content[0]).toHaveProperty('provider_replay');
  });

  it('keeps no replay of a message over the size cap, deterministically', () => {
    const big = {
      anthropic: {
        model: 'claude-test',
        blocks: [{ type: 'redacted_thinking', data: 'x'.repeat(MAX_THINK_REPLAY_CHARS) }],
      },
    };
    const split = splitProviderItems([
      { type: 'think', think: '', provider_replay: replay },
      { type: 'think', think: '', provider_replay: big },
    ]);
    expect(split?.providerItems).toEqual({});
    expect(JSON.stringify(split?.content)).not.toContain('SIG');
  });

  it('ignores a replay on a part that is not reasoning', () => {
    expect(
      splitProviderItems([{ type: 'text', text: 'x', provider_replay: replay }]),
    ).toBeUndefined();
  });
});
