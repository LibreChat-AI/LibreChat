import { useEffect } from 'react';
import { RecoilRoot } from 'recoil';
import { DndProvider } from 'react-dnd';
import { RouterProvider } from 'react-router-dom';
import * as RadixToast from '@radix-ui/react-toast';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/react-query';
import { Toast, ThemeProvider, ToastProvider, useInputModality } from '@librechat/client';
import { ScreenshotProvider, useApiErrorBoundary, flushProgressiveRowMounts } from './hooks';
import WakeLockManager from '~/components/System/WakeLockManager';
import QueryDevtoolsGate from '~/components/QueryDevtoolsGate';
import LanguageSync from '~/components/System/LanguageSync';
import { getThemeFromEnv } from './utils/getThemeFromEnv';
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

  useEffect(() => {
    /** Force any windowed-out message rows to mount before the browser's
     *  print pipeline reads the DOM, so long threads never print truncated.
     *  Synchronous: `beforeprint` is dispatched synchronously and the
     *  browser never waits on a handler's return value, so an async
     *  completion (as screenshot export uses) would run too late. */
    const handleBeforePrint = () => {
      flushProgressiveRowMounts();
    };
    window.addEventListener('beforeprint', handleBeforePrint);
    return () => window.removeEventListener('beforeprint', handleBeforePrint);
  }, []);

  // Load theme from environment variables if available
  const envTheme = getThemeFromEnv();

  return (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <LanguageSync />
        <LiveAnnouncer>
          <ThemeProvider
            // Only pass initialTheme and themeRGB if environment theme exists
            // This allows localStorage values to persist when no env theme is set
            {...(envTheme && { initialTheme: 'system', themeRGB: envTheme })}
          >
            {/* The ThemeProvider will automatically:
                1. Apply dark/light mode classes
                2. Apply custom theme colors if envTheme is provided
                3. Otherwise use stored theme preferences from localStorage
                4. Fall back to default theme colors if nothing is stored */}
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
          </ThemeProvider>
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
      style={{
        display: 'none',
      }}
    />
  </ScreenshotProvider>
);
