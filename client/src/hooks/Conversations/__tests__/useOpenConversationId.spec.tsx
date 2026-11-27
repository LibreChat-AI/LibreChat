import { Constants } from 'librechat-data-provider';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import type { TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useOpenConversationId from '../useOpenConversationId';
import store from '~/store';

const chat = (conversationId: string) => ({ conversationId }) as TConversation;

function setup(path: string, conversationId: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RecoilRoot
      initializeState={({ set }) => set(store.conversationByIndex(0), chat(conversationId))}
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/c/:conversationId" element={children} />
          <Route path="*" element={children} />
        </Routes>
      </MemoryRouter>
    </RecoilRoot>
  );
  return renderHook(
    () => ({
      read: useOpenConversationId(),
      navigate: useNavigate(),
      setChat: useSetRecoilState(store.conversationByIndex(0)),
    }),
    { wrapper },
  );
}

describe('useOpenConversationId', () => {
  it('names the routed conversation before the chat state has followed the route', () => {
    const { result } = setup('/c/convo-2', 'convo-1');

    expect(result.current.read()).toBe('convo-2');
  });

  it('names the chat a first turn started while the route still reads new', () => {
    const { result } = setup(`/c/${Constants.NEW_CONVO}`, 'convo-1');

    expect(result.current.read()).toBe('convo-1');
  });

  it('names no saved conversation while the open chat is unsent', () => {
    const { result } = setup(`/c/${Constants.NEW_CONVO}`, Constants.NEW_CONVO);

    expect(result.current.read()).toBe(Constants.NEW_CONVO);
  });

  it('names nothing away from a chat route', () => {
    const { result } = setup('/search', 'convo-1');

    expect(result.current.read()).toBeUndefined();
  });

  it('answers for the chat open when it is called, through the reader it handed out earlier', () => {
    const { result } = setup('/c/convo-1', 'convo-1');
    const { read } = result.current;

    act(() => {
      result.current.navigate(`/c/${Constants.NEW_CONVO}`);
      result.current.setChat(chat(Constants.NEW_CONVO));
    });

    expect(result.current.read).toBe(read);
    expect(read()).toBe(Constants.NEW_CONVO);
  });
});
