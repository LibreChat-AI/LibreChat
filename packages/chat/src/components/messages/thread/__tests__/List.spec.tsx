/**
 * @jest-environment jsdom
 */
import { Provider, createStore } from 'jotai';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { RowMountWindow } from '../../../../react/messages/useProgressiveRowMount';
import type { ThreadRow } from '../../../../core/thread';
import { useRowMounted, RowMountProvider } from '../../../../react/messages/useProgressiveRowMount';
import { createMessagesHost } from '../../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../../react/messages/host';
import List from '../List';

/** Counts the rows that wait on the mount window, which is every row that renders. */
jest.mock('../../../../react/messages/useProgressiveRowMount', () => {
  const actual = jest.requireActual('../../../../react/messages/useProgressiveRowMount');
  return { ...actual, useRowMounted: jest.fn(actual.useRowMounted) };
});

jest.mock('../Message', () => ({
  __esModule: true,
  default: ({ message }: { message: TMessage }) => (
    <div data-testid={`row-${message.messageId}`}>{message.text}</div>
  ),
}));

const row = (depth: number, text = `turn ${depth}`): ThreadRow => {
  const message = {
    messageId: `m${depth}`,
    parentMessageId: depth === 0 ? 'root' : `m${depth - 1}`,
    conversationId: 'convo-1',
    text,
    depth,
  } as TMessage;
  return {
    source: message,
    message,
    parentKey: message.parentMessageId ?? 'root',
    depth,
    siblingIdx: 0,
    siblingCount: 1,
    childCount: 1,
  };
};

const host = createMessagesHost({ renderActivity: () => null });
const store = createStore();
const setCurrentEditId = jest.fn();

const thread = (rows: ThreadRow[], mountWindow: RowMountWindow = null) => (
  <Provider store={store}>
    <MessagesHostProvider host={host}>
      <RowMountProvider mountWindow={mountWindow}>
        <List rows={rows} currentEditId={null} setCurrentEditId={setCurrentEditId} />
      </RowMountProvider>
    </MessagesHostProvider>
  </Provider>
);

const mounted = () =>
  screen.queryAllByTestId(/^row-/).map((element) => element.getAttribute('data-testid'));

describe('the flat thread list', () => {
  beforeEach(() => {
    jest.mocked(useRowMounted).mockClear();
  });

  it('renders only the row that changed when a reply grows', () => {
    const settled = [row(0), row(1), row(2)];
    const view = render(thread([...settled, row(3, 'E2E')]));
    expect(mounted()).toHaveLength(4);

    /** A frame of the reply: a new list, in which every settled row is the row it was. */
    jest.mocked(useRowMounted).mockClear();
    view.rerender(thread([...settled, row(3, 'E2E reply')]));
    expect(screen.getByTestId('row-m3')).toHaveTextContent('E2E reply');
    expect(useRowMounted).toHaveBeenCalledTimes(1);
    expect(useRowMounted).toHaveBeenCalledWith(3);
  });

  it('holds back the rows outside the mount window and mounts them as it widens', () => {
    const rows = [row(0), row(1), row(2)];
    const view = render(thread(rows, { start: 2, end: Number.POSITIVE_INFINITY }));
    expect(mounted()).toEqual(['row-m2']);

    view.rerender(thread(rows, { start: 1, end: Number.POSITIVE_INFINITY }));
    expect(mounted()).toEqual(['row-m1', 'row-m2']);

    view.rerender(thread(rows, null));
    expect(mounted()).toEqual(['row-m0', 'row-m1', 'row-m2']);
  });
});
