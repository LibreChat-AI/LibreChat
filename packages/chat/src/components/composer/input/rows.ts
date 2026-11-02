import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * The number of visual rows the draft occupies, measured from the textarea's scroll height.
 * The composer commits once per keystroke already; a second commit for a row count that did not
 * move (or that no layout engine can measure, where `lineHeight` is not a number) would double
 * the cost of the app's busiest surface for nothing.
 */
export default function useVisualRowCount(
  textAreaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  remScale: number,
): number {
  const [rowCount, setRowCount] = useState(1);
  const measured = useRef(1);

  useEffect(() => {
    const textarea = textAreaRef.current;
    if (!textarea) {
      return;
    }
    const lineHeight = parseFloat(window.getComputedStyle(textarea).lineHeight);
    if (!(lineHeight > 0)) {
      return;
    }
    const next = Math.floor(textarea.scrollHeight / lineHeight);
    if (next === measured.current) {
      return;
    }
    measured.current = next;
    setRowCount(next);
  }, [textAreaRef, value, remScale]);

  return rowCount;
}
