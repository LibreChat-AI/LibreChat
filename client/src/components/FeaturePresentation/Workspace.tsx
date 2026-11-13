import { useContext, useRef } from 'react';
import {
  useLocation,
  useOutlet,
  UNSAFE_LocationContext,
  UNSAFE_RouteContext,
} from 'react-router-dom';
import { ChatInteractionContext } from '~/Providers/ChatInteractionContext';
import { useFeaturePresentation } from './Context';
import { getRelatedPage } from './registry';

/** Keep the live chat route, including its composer and transport, mounted behind a feature page. */
export default function PresentationWorkspace() {
  const outlet = useOutlet();
  const location = useLocation();
  const locationContext = useContext(UNSAFE_LocationContext);
  const routeContext = useContext(UNSAFE_RouteContext);
  const presentation = useFeaturePresentation();
  const chat = /^\/c(?:\/|$)/.test(location.pathname);
  const retained = useRef<{
    outlet: typeof outlet;
    location: typeof locationContext;
    route: typeof routeContext;
  }>();
  if (chat) {
    retained.current = { outlet, location: locationContext, route: routeContext };
  } else if (!getRelatedPage(location.pathname)) {
    retained.current = undefined;
  }
  return (
    <>
      <div
        hidden={!chat}
        inert={!chat ? '' : undefined}
        className={chat ? 'flex h-full min-h-0 flex-col' : 'hidden'}
      >
        {retained.current && (
          <UNSAFE_LocationContext.Provider
            value={{
              ...retained.current.location,
              location: chat
                ? location
                : (presentation?.chatLocation ?? retained.current.location.location),
            }}
          >
            <UNSAFE_RouteContext.Provider value={retained.current.route}>
              <ChatInteractionContext.Provider value={chat}>
                {retained.current.outlet}
              </ChatInteractionContext.Provider>
            </UNSAFE_RouteContext.Provider>
          </UNSAFE_LocationContext.Provider>
        )}
      </div>
      {!chat && outlet}
    </>
  );
}
