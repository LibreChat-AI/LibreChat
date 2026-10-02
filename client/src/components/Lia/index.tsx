import { lazy, Suspense, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { TSubmission } from 'librechat-data-provider';
import type { RefObject } from 'react';
import { useGetStartupConfig } from '~/data-provider';
import { showLiaAtom } from '~/store/lia';

/* The engine and its art load only for people who turned Lia on, after the page has painted,
 * so the welcome screen's first paint never waits on them. */
const Stage = lazy(() => import('./Stage'));

/** How long Lia stays to wave off the first message after the welcome screen gives way. */
export const FAREWELL_MS = 1900;

interface LiaProps {
  /** The composer band Lia stands on. */
  bandRef: RefObject<HTMLElement>;
  /** Whether the welcome screen is showing. */
  landing: boolean;
  /** The latest send. Every endpoint sets it in the same update that adds the first message,
   * unlike `isSubmitting`, which Assistants endpoints only raise once their stream opens. */
  submission: TSubmission | null;
}

/**
 * Lia, the welcome screen mascot. Purely decorative: hidden from assistive technology, and
 * shown only when the deployment allows it (`interface.mascot`) and the user opted in.
 */
export default function Lia({ bandRef, landing, submission }: LiaProps) {
  const show = useAtomValue(showLiaAtom);
  const { data: startupConfig } = useGetStartupConfig();
  const [prevLanding, setPrevLanding] = useState(landing);
  /* The send already in place while the welcome screen showed, such as one left from an
   * earlier conversation, so only a new one counts as sending from here. */
  const [seen, setSeen] = useState(submission);
  const [leaving, setLeaving] = useState(false);
  if (landing && submission !== seen) {
    setSeen(submission);
  }
  /* Leaving the welcome screen by sending a message gets a farewell; navigating away does not. */
  if (landing !== prevLanding) {
    setPrevLanding(landing);
    setLeaving(!landing && submission != null && submission !== seen);
  }

  useEffect(() => {
    if (!leaving) {
      return;
    }
    const timer = setTimeout(() => setLeaving(false), FAREWELL_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const allowed = startupConfig != null && startupConfig.interface?.mascot !== false;
  if (!show || !allowed || (!landing && !leaving)) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <Stage bandRef={bandRef} leaving={leaving} />
    </Suspense>
  );
}
