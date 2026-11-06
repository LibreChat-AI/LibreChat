import { MAX_PROVIDER_ITEMS_CHARS, splitProviderItems } from './providerItems';

const items = { origin: 'digest', items: [{ id: 'rs_1', encrypted_content: 'opaque' }] };

describe('splitProviderItems', () => {
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

  it('keeps no items of a message over the size cap, and still strips them from the content', () => {
    const big = {
      origin: 'digest',
      items: [{ encrypted_content: 'x'.repeat(MAX_PROVIDER_ITEMS_CHARS) }],
    };
    const split = splitProviderItems([
      { type: 'tool_call', tool_call: { id: 'call_1', providerItems: items } },
      { type: 'tool_call', tool_call: { id: 'call_2', providerItems: big } },
    ]);
    expect(split).toEqual({
      content: [
        { type: 'tool_call', tool_call: { id: 'call_1' } },
        { type: 'tool_call', tool_call: { id: 'call_2' } },
      ],
      providerItems: {},
    });
  });
});
