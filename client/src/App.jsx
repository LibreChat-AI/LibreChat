import { useEffect } from 'react';
import { RecoilRoot } from 'recoil';
import { DndProvider } from 'react-dnd';
import { RouterProvider } from 'react-router-dom';
import * as RadixToast from '@radix-ui/react-toast';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { Toast, ToastProvider, useInputModality } from '@librechat/client';
import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/react-query';
import { ScreenshotProvider, useApiErrorBoundary } from './hooks';
import WakeLockManager from '~/components/System/WakeLockManager';
import QueryDevtoolsGate from '~/components/QueryDevtoolsGate';
import LanguageSync from '~/components/System/LanguageSync';
import DeploymentTheme from '~/Providers/DeploymentTheme';
import { initializeFontSize } from '~/store/fontSize';
import { LiveAnnouncer } from '~/a11y';
import { router } from './routes';

const App = () => {
  const { setError } = useApiErrorBoundary();
  useInputModality();

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Always attempt network requests, even when navigator.onLine is false
        // This is needed because localhost is reachable without WiFi
        networkMode: 'always',
      },
      mutations: {
        networkMode: 'always',
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        if (error?.response?.status === 401) {
          setError(error);
        }
      },
    }),
  });

  useEffect(() => {
    initializeFontSize();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <LanguageSync />
        <LiveAnnouncer>
          <DeploymentTheme>
            <RadixToast.Provider>
              <ToastProvider>
                <DndProvider backend={HTML5Backend}>
                  {/* Location updates commit in the caller's own task instead
                      of React's transition lane. A transition keeps the
                      OUTGOING route painted until the incoming one finishes
                      rendering, so switching conversations left the previous
                      transcript on screen under the new URL for as long as the
                      next thread took to render.

                      Set here rather than per navigation because the property
                      is route-shaped, not caller-shaped: fourteen call sites
                      across components, chat hooks and SSE handlers navigate
                      into `/c/*`, and an opt-out passed at each one is a list
                      that silently rots as call sites are added. Nothing in the
                      app reads route data through router loaders or renders
                      pending UI from `useNavigation`, so the transition buys no
                      interstitial on any route — it only defers the commit. And
                      conversation state still lives in Recoil, whose
                      transition-safe reads are gated behind
                      `_TRANSITION_SUPPORT_UNSTABLE` hooks this app does not use.
                      Worth revisiting once that state has moved to Jotai. */}
                  <RouterProvider router={router} useTransitions={false} />
                  <WakeLockManager />
                  <QueryDevtoolsGate />
                  <Toast />
                  <RadixToast.Viewport className="pointer-events-none fixed inset-x-0 top-0 z-[1000] mx-auto my-2 flex max-w-[560px] flex-col items-stretch justify-start" />
                </DndProvider>
              </ToastProvider>
            </RadixToast.Provider>
          </DeploymentTheme>
        </LiveAnnouncer>
      </RecoilRoot>
    </QueryClientProvider>
  );
};

export default () => (
  <ScreenshotProvider>
    <App />
    <iframe
      src="assets/silence.mp3"
      allow="autoplay"
      id="audio"
      title="audio-silence"
      className="hidden"
    />
  </ScreenshotProvider>
);
