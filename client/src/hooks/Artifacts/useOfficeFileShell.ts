import { useEffect, useRef, useState } from 'react';
import { fillOfficeFileShell, isOfficeFileShell } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import { useFilePreviewBlob } from '~/data-provider';
import { useShareContext } from '~/Providers';

const readBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

interface FilledShell {
  key: string;
  shell: string;
  content: string;
}

/** Fills a stored office-preview shell with its file's bytes; a failed fetch leaves the shell as stored. */
export default function useOfficeFileShell(artifact: Artifact | null): {
  content: string | undefined;
  isLoading: boolean;
} {
  const { shareId } = useShareContext();
  const { refetch } = useFilePreviewBlob(
    artifact?.download?.user,
    artifact?.download?.file_id,
    shareId,
  );
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const [filled, setFilled] = useState<FilledShell | null>(null);

  const stored = artifact?.content;
  const isShell =
    stored != null && artifact?.download?.file_id != null && isOfficeFileShell(stored);

  const key = `${artifact?.id}:${artifact?.download?.file_id}`;

  useEffect(() => {
    if (!isShell) {
      return;
    }
    let cancelled = false;
    const settle = (content: string) => {
      if (!cancelled) {
        setFilled({ key, shell: stored, content });
      }
    };
    refetchRef
      .current()
      .then(({ data }) => (data instanceof Blob ? readBase64(data) : Promise.reject(new Error())))
      .then((base64) => settle(fillOfficeFileShell(stored, base64)))
      .catch(() => settle(stored));
    return () => {
      cancelled = true;
    };
  }, [isShell, stored, key]);

  if (!isShell) {
    return { content: stored, isLoading: false };
  }
  const isCurrent = filled?.key === key && filled.shell === stored;
  return { content: isCurrent ? filled.content : stored, isLoading: !isCurrent };
}
