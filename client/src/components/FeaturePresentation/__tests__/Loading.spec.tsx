import React, { lazy } from 'react';
import { Provider } from 'jotai';
import { Bot } from 'lucide-react';
import { resolveNavigation } from 'librechat-data-provider';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { FeaturePresentationProvider, FeatureSlot, useFeaturePresentation } from '../Context';

it('loads a retained feature only on demand and displays its pending chunk state', async () => {
  let finish!: (module: { default: ComponentType<{ visible: boolean }> }) => void;
  const load = jest.fn(
    () =>
      new Promise<{ default: ComponentType<{ visible: boolean }> }>((resolve) => {
        finish = resolve;
      }),
  );
  const features = { agentBuilder: lazy(load) };
  const navigation = resolveNavigation({ pages: { agentBuilder: { enabled: true } } });
  function Controls() {
    const presentation = useFeaturePresentation()!;
    return (
      <>
        <button onClick={() => presentation.expand('agentBuilder')}>{'Expand lazy feature'}</button>
        {presentation.page === 'agentBuilder' && (
          <FeatureSlot page="agentBuilder" view="page" visible />
        )}
      </>
    );
  }
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <FeaturePresentationProvider
            links={[{ id: 'agents', title: 'com_sidepanel_agent_builder', icon: Bot }]}
            features={features}
            navigation={navigation}
            onPanelOpen={jest.fn()}
          >
            <Controls />
          </FeaturePresentationProvider>
        ),
      },
    ],
    { initialEntries: ['/c/new'] },
  );
  render(
    <Provider>
      <RouterProvider router={router} />
    </Provider>,
  );
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Expand lazy feature'));
  expect(screen.getByRole('status')).toHaveTextContent('Loading');
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => finish({ default: () => <input aria-label="Loaded editor" /> }));
  expect(await screen.findByLabelText('Loaded editor')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
