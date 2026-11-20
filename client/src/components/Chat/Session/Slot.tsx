import { memo } from 'react';
import { useSetAtom } from 'jotai';
import { sessionRailSlot } from './state';

/**
 * The session rail's column in the chat layout. It takes no room until a rail is drawn in it,
 * and it is memoized because the layout around it renders for every frame of a streaming reply.
 */
function SessionRailSlot() {
  const setSlot = useSetAtom(sessionRailSlot);
  return <div ref={setSlot} className="contents" data-testid="session-rail-slot" />;
}

export default memo(SessionRailSlot);
