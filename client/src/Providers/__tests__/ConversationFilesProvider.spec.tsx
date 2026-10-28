import React, { useContext } from 'react';
import { render } from '@testing-library/react';
import type { TAttachment, TMessage } from 'librechat-data-provider';
import { ConversationFilesContext, ConversationFilesProvider } from '../MediaContext';

const file = (filename: string, file_id: string) =>
  ({
    filename,
    file_id,
    filepath: `/api/files/${file_id}/${filename}`,
    user: 'u1',
    source: 'execute_code',
  }) as unknown as TAttachment;

const messages = (text: string, extra: TAttachment[] = []) =>
  [
    { messageId: '1', text: 'hi', attachments: [file('deck.pptx', 'a')] },
    { messageId: '2', text, attachments: extra },
  ] as unknown as TMessage[];

function setup() {
  const seen: Array<ReadonlyMap<string, TAttachment> | undefined> = [];
  const Consumer = () => {
    seen.push(useContext(ConversationFilesContext));
    return null;
  };
  const ui = (m: TMessage[] | null) => (
    <ConversationFilesProvider messages={m}>
      <Consumer />
    </ConversationFilesProvider>
  );
  return { seen, ui };
}

describe('ConversationFilesProvider', () => {
  it('keeps the same map when new message objects carry the same files', () => {
    const { seen, ui } = setup();
    const { rerender } = render(ui(messages('a')));
    rerender(ui(messages('a and more')));
    expect(seen[seen.length - 1]).toBe(seen[0]);
  });

  it('publishes a new map when an attachment is added', () => {
    const { seen, ui } = setup();
    const { rerender } = render(ui(messages('a')));
    rerender(ui(messages('a', [file('new.csv', 'b')])));
    const last = seen[seen.length - 1];
    expect(last).not.toBe(seen[0]);
    expect(last?.has('new.csv')).toBe(true);
  });

  it('publishes a new map when a name now points at a different file', () => {
    const { seen, ui } = setup();
    const { rerender } = render(ui(messages('a')));
    const swapped = [
      { messageId: '1', text: 'hi', attachments: [file('deck.pptx', 'z')] },
      { messageId: '2', text: 'a', attachments: [] },
    ] as unknown as TMessage[];
    rerender(ui(swapped));
    const last = seen[seen.length - 1];
    expect(last).not.toBe(seen[0]);
    expect((last?.get('deck.pptx') as { file_id?: string }).file_id).toBe('z');
  });

  it('yields an empty map for null messages', () => {
    const { seen, ui } = setup();
    const { rerender } = render(ui(messages('a')));
    rerender(ui(null));
    expect(seen[seen.length - 1]?.size).toBe(0);
  });
});
