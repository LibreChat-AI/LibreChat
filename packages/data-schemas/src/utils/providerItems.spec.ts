import { splitProviderItems } from './providerItems';

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
