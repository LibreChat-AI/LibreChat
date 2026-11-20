import React, { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, EModelEndpoint, defaultOrderQuery } from 'librechat-data-provider';
import type { Assistant, TConversation, DeleteAssistantBody } from 'librechat-data-provider';
import ContextButton from '../ContextButton';

let mockSuccess: (_data: void, vars: DeleteAssistantBody, context?: unknown) => void;
const mockToast = jest.fn();
const mockReset = jest.fn();
jest.mock('@librechat/client', () => ({
  Label: () => null,
  Button: () => null,
  TrashIcon: () => null,
  OGDialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  OGDialogTrigger: () => null,
  OGDialogTemplate: () => null,
  useToastContext: () => ({ showToast: mockToast }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/data-provider', () => ({
  useDeleteAssistantMutation: (options: { onSuccess: typeof mockSuccess }) => {
    mockSuccess = options.onSuccess;
    return {};
  },
}));
jest.mock('~/Providers', () => ({
  useChatContext: () => jest.requireActual('react').useContext(mockContext),
}));
const mockContext = React.createContext({
  setConversation: (_update: React.SetStateAction<TConversation | null>) => {},
});

function setup(selected = 'asst-deleted', list?: Array<{ id: string; model: string }>) {
  const client = new QueryClient();
  if (list)
    client.setQueryData([QueryKeys.assistants, EModelEndpoint.assistants, defaultOrderQuery], {
      data: list,
    });
  function Harness() {
    const [conversation, setConversation] = useState<TConversation | null>({
      endpoint: EModelEndpoint.assistants,
      assistant_id: selected,
      model: 'old-model',
    } as TConversation);
    const [builderId, setBuilderId] = useState<string | undefined>('asst-deleted');
    return (
      <mockContext.Provider value={{ setConversation }}>
        <output data-testid="selection">{JSON.stringify({ conversation, builderId })}</output>
        <ContextButton
          activeModel="old-model"
          assistant_id="asst-deleted"
          endpoint={EModelEndpoint.assistants}
          setCurrentAssistantId={setBuilderId}
          createMutation={{ data: { id: 'asst-deleted' } as Assistant, reset: mockReset }}
        />
      </mockContext.Provider>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return () => JSON.parse(screen.getByTestId('selection').textContent ?? '{}');
}
beforeEach(() => jest.clearAllMocks());
it('reads the updated list rather than mutation context and carries the replacement model', () => {
  const state = setup('asst-deleted', [{ id: 'asst-next', model: 'public-next' }]);
  act(() =>
    mockSuccess(undefined, {
      assistant_id: 'asst-deleted',
      endpoint: EModelEndpoint.assistants,
      model: 'old-model',
    }),
  );
  expect(state()).toMatchObject({
    conversation: { assistant_id: 'asst-next', model: 'public-next' },
    builderId: 'asst-next',
  });
  expect(mockToast).toHaveBeenCalled();
  expect(mockReset).toHaveBeenCalled();
});
it.each([undefined, []])(
  'clears a deleted selection when the list is missing or empty (%j)',
  (list) => {
    const state = setup('asst-deleted', list);
    act(() =>
      mockSuccess(
        undefined,
        { assistant_id: 'asst-deleted', endpoint: EModelEndpoint.assistants, model: 'old-model' },
        { snapshot: true },
      ),
    );
    expect(state().conversation.assistant_id).toBe('');
    expect(state().conversation.model).toBeUndefined();
    expect(mockToast).toHaveBeenCalled();
  },
);
it('does not overwrite a newer conversation selection after deletion finishes', () => {
  const state = setup('asst-newer', [{ id: 'asst-next', model: 'next-model' }]);
  act(() =>
    mockSuccess(undefined, {
      assistant_id: 'asst-deleted',
      endpoint: EModelEndpoint.assistants,
      model: 'old-model',
    }),
  );
  expect(state().conversation.assistant_id).toBe('asst-newer');
});
