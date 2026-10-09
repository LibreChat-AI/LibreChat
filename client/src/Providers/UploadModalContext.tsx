import React, {
  useRef,
  useMemo,
  useState,
  useEffect,
  useContext,
  useCallback,
  createContext,
} from 'react';

interface UploadModalContextValue {
  isVisible: boolean;
  files: File[];
  openModal: (files: File[]) => void;
  closeModal: () => void;
}

const defaultValue: UploadModalContextValue = {
  isVisible: false,
  files: [],
  openModal: () => undefined,
  closeModal: () => undefined,
};

const UploadModalContext = createContext<UploadModalContextValue>(defaultValue);

export function UploadModalProvider({ children }: { children: React.ReactNode }) {
  const [isVisible, setIsVisible] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  /**
   * A paste or a drop opens this dialog programmatically, so there is no
   * `Dialog.Trigger` for Radix to hand focus back to — and its modal content
   * always cancels the default restore in favour of that missing trigger,
   * dropping focus on `document.body`. The composer's Enter-to-send is a
   * textarea key handler, so the user is left holding a full draft and an
   * enabled send button that Enter no longer reaches, until they click back
   * into the composer. Remember where the upload was started from instead.
   */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const openModal = useCallback((nextFiles: File[]) => {
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement ? active : null;
    setFiles(nextFiles);
    setIsVisible(true);
  }, []);

  const closeModal = useCallback(() => {
    setIsVisible(false);
    setFiles([]);
  }, []);

  useEffect(() => {
    if (isVisible) {
      return;
    }
    const element = returnFocusRef.current;
    returnFocusRef.current = null;
    if (element == null || !element.isConnected) {
      return;
    }
    /** Radix restores focus from the dialog's own unmount cleanup, deferred by
     * a timeout of its own. This effect runs after that cleanup, so the queued
     * restore lands last. */
    const timeout = setTimeout(() => element.focus({ preventScroll: true }), 0);
    return () => clearTimeout(timeout);
  }, [isVisible]);

  const value = useMemo<UploadModalContextValue>(
    () => ({ isVisible, files, openModal, closeModal }),
    [isVisible, files, openModal, closeModal],
  );

  return <UploadModalContext.Provider value={value}>{children}</UploadModalContext.Provider>;
}

export function useUploadModalContext() {
  return useContext(UploadModalContext);
}
