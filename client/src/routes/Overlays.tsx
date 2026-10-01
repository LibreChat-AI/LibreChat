import { useLayoutEffect, useState } from 'react';
import { OverlayBackProvider, useMediaQuery } from '@librechat/client';
import { Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { createOverlayDismissal } from '~/utils/overlays';

export default function Overlays() {
  const isMobile = useMediaQuery('(max-width: 868px)');
  const location = useLocation();
  const action = useNavigationType();
  const [overlays] = useState(() => createOverlayDismissal(window));
  useLayoutEffect(() => overlays.listen(), [overlays]);
  useLayoutEffect(() => overlays.navigated(action), [action, location, overlays]);
  return (
    <OverlayBackProvider value={isMobile ? overlays.register : null}>
      <Outlet />
    </OverlayBackProvider>
  );
}
