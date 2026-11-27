import { useRef, useState, useCallback, useEffect } from 'react';
import type { RefObject } from 'react';
import { getCodeBlockFilename, triggerDownload } from '../../core/download';

export interface DownloadCode {
  isDownloaded: boolean;
  buttonRef: RefObject<HTMLButtonElement>;
  handleDownload: () => void;
}

export default function useDownloadCode(
  codeRef: RefObject<HTMLElement | null>,
  lang?: string,
): DownloadCode {
  const [isDownloaded, setIsDownloaded] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    return () => clearTimeout(timerRef.current);
  }, []);

  const handleDownload = useCallback(() => {
    const codeString = codeRef.current?.textContent;
    if (codeString == null || codeString === '') {
      return;
    }

    const wasFocused = document.activeElement === buttonRef.current;
    setIsDownloaded(true);
    const blob = new Blob([codeString], { type: 'text/plain' });
    triggerDownload(URL.createObjectURL(blob), getCodeBlockFilename(lang));

    if (wasFocused) {
      requestAnimationFrame(() => buttonRef.current?.focus());
    }

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setIsDownloaded(false);
    }, 3000);
  }, [codeRef, lang]);

  return { isDownloaded, buttonRef, handleDownload };
}
