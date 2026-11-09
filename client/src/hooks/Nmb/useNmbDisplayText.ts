import { useEffect, useState } from 'react';
import { dataService, NMB_PLACEHOLDER_REGEX, stripNmbMaskNote } from 'librechat-data-provider';
import { useNmbMeQuery } from '~/data-provider';

const MAX_CACHE = 200;
/** Display-only results. Never written back to the message store or sent anywhere. */
const unmaskCache = new Map<string, string>();

/**
 * What to show for a message while the gateway is on. The stored text stays masked (that is what
 * the model sees on later turns); this only changes the rendering:
 * - the gateway's one-line note is hidden from the user's own message;
 * - placeholders in a finished assistant reply are restored for the signed-in user through the
 *   server, which derives the mapping from the session.
 * With the gateway off, or while streaming, the text is returned unchanged.
 */
export default function useNmbDisplayText(
  text: string,
  { isCreatedByUser, streaming }: { isCreatedByUser: boolean; streaming: boolean },
): { text: string; masked: boolean } {
  const { data: me } = useNmbMeQuery();
  const enabled = me?.enabled === true;
  const visible = enabled && isCreatedByUser ? stripNmbMaskNote(text) : text;
  const masked = enabled && NMB_PLACEHOLDER_REGEX.test(visible);
  const shouldUnmask = masked && !isCreatedByUser && !streaming;
  const [restored, setRestored] = useState<string | undefined>(() =>
    shouldUnmask ? unmaskCache.get(text) : undefined,
  );

  useEffect(() => {
    if (!shouldUnmask) {
      setRestored(undefined);
      return;
    }
    const cached = unmaskCache.get(text);
    if (cached != null) {
      setRestored(cached);
      return;
    }
    let cancelled = false;
    dataService
      .unmaskNmbText(text)
      .then((res) => {
        if (unmaskCache.size >= MAX_CACHE) {
          unmaskCache.delete(unmaskCache.keys().next().value as string);
        }
        unmaskCache.set(text, res.text);
        if (!cancelled) {
          setRestored(res.text);
        }
      })
      .catch(() => {
        /** Leave the masked text in place; it is always safe to show. */
        if (!cancelled) {
          setRestored(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [shouldUnmask, text]);

  return { text: shouldUnmask && restored != null ? restored : visible, masked };
}
