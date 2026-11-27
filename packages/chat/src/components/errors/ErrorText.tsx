import { useLocalize } from '@librechat/client';
import type { ReactNode } from 'react';
import type { ErrorSource } from '../../core/errors';
import { classifyErrorText, errorCopyKey } from '../../core/errors';
import { useErrorSource } from '../../react/messages/error';
import { UnclassifiedError } from './ProviderError';
import { errorRenderer } from './registry';

/**
 * Renders a failed turn from whatever the server managed to persist.
 *
 * Three kinds of text arrive here: a typed payload this app produced, a provider's own error body,
 * and unclassified prose. A payload with copy wins, because it is the only one written for a
 * reader; everything else is shown through `UnclassifiedError`, which leads with what is known and
 * keeps the raw provider text as a detail rather than as the headline.
 *
 * `message` is the row when the caller has it; an error content part renders without one and reads
 * its row's identity from `ErrorSourceProvider` instead.
 */
export default function ErrorText({
  text,
  message: rowMessage,
}: {
  text: string;
  message?: ErrorSource;
}): ReactNode {
  const localize = useLocalize();
  const contextSource = useErrorSource();
  const message = rowMessage ?? contextSource;

  const kind = classifyErrorText(text);
  if (kind.kind === 'langchain') {
    return localize(kind.key);
  }
  if (kind.kind === 'prose') {
    return <UnclassifiedError text={text} message={message} />;
  }

  const { json, payload, code } = kind;
  if (code != null) {
    const Renderer = errorRenderer(code);
    if (Renderer != null) {
      return <Renderer json={payload} text={text} message={message} />;
    }
    const copyKey = errorCopyKey(code);
    if (copyKey != null) {
      return localize(copyKey);
    }
  }

  return <UnclassifiedError json={json} text={text} message={message} />;
}
