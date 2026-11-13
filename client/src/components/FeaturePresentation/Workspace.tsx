import { useContext, useRef } from 'react';
import {
  useLocation,
  useOutlet,
  UNSAFE_LocationContext,
  UNSAFE_RouteContext,
} from 'react-router-dom';
import { useFeaturePresentation } from './Context';

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
  } else if (!presentation?.page) {
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
          <UNSAFE_LocationContext.Provider value={retained.current.location}>
            <UNSAFE_RouteContext.Provider value={retained.current.route}>
              {retained.current.outlet}
            </UNSAFE_RouteContext.Provider>
          </UNSAFE_LocationContext.Provider>
        )}
      </div>
      {!chat && outlet}
    </>
  );
}
