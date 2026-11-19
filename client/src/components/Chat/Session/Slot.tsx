import { useSetAtom } from 'jotai';
import { sessionRailSlot } from './state';

/** The session rail's column in the chat layout. It takes no room until a rail is drawn in it. */
export default function SessionRailSlot() {
  const setSlot = useSetAtom(sessionRailSlot);
  return <div ref={setSlot} className="contents" data-testid="session-rail-slot" />;
}
