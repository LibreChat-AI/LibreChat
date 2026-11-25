import type { TextContentFragment } from './types';
import { isLegacyPiiFragment } from './legacy';

function fragment(
  id: string,
  field: TextContentFragment['field'] = 'text',
): Extract<TextContentFragment, { readonly source: 'message' }> {
  return {
    id,
    text: 'value',
    path: `/${id}`,
    source: 'message',
    field,
    format: 'plain',
    treatment: 'replaceable',
    provenance: 'user',
  } as Extract<TextContentFragment, { readonly source: 'message' }>;
}

describe('isLegacyPiiFragment', () => {
  it.each([
    'chat.text',
    'chat.input',
    'chat.answer',
    'chat.quote.0',
    'chat.decision.1.response',
    'chat.decision.1.reason',
    'external-message.0.content',
    'external-message.2.part.3',
    'stored-message.text',
  ])('inspects %s', (id) => {
    expect(isLegacyPiiFragment(fragment(id))).toBe(true);
  });

  it('limits stored message fields to the ones it historically inspected', () => {
    expect(isLegacyPiiFragment(fragment('stored-message.text', 'text'))).toBe(true);
    expect(isLegacyPiiFragment(fragment('stored-message.name.sender', 'name'))).toBe(false);
  });

  it.each(['stored-message.assembled', 'stored-message.user-submitted-assembled'])(
    'inspects split submitted prose through %s',
    (id) => {
      const assembled = {
        ...fragment(id),
        source: 'assembled_context',
        field: 'assembled_context',
        treatment: 'inspect_only',
      } as TextContentFragment;
      expect(isLegacyPiiFragment(assembled)).toBe(true);
    },
  );

  it('ignores names, attachment references and tool-call arguments', () => {
    expect(isLegacyPiiFragment(fragment('external-message.0.name', 'name'))).toBe(false);
    expect(
      isLegacyPiiFragment(
        fragment('external-message.0.part.0.attachment.filename', 'attachment_reference'),
      ),
    ).toBe(false);
    expect(
      isLegacyPiiFragment({
        ...fragment('external-message.0.tool-call.0.arguments', 'arguments'),
        source: 'tool_argument',
      } as TextContentFragment),
    ).toBe(false);
  });
});
