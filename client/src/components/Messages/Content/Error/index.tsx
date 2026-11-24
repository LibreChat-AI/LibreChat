import { classifyErrorText, errorCopyKey } from '@librechat/chat';
import type { TranslationKeys } from '~/hooks';
import type { ErrorSource } from './source';
import { UnclassifiedError } from './ProviderError';
import { errorRenderers } from './registry';
import { useErrorSource } from './source';
import { useLocalize } from '~/hooks';

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
const Error = ({ text, message: rowMessage }: { text: string; message?: ErrorSource }) => {
  const localize = useLocalize();
  const contextSource = useErrorSource();
  const message = rowMessage ?? contextSource;

  const kind = classifyErrorText(text);
  if (kind.kind === 'langchain') {
    return localize(kind.key as TranslationKeys);
  }
  if (kind.kind === 'prose') {
    return <UnclassifiedError text={text} message={message} />;
  }

  const { json, payload, code: errorKey } = kind;
  if (errorKey != null) {
    const Renderer = errorRenderers[errorKey];
    if (Renderer != null) {
      return <Renderer json={payload} text={text} message={message} />;
    }
    const copyKey = errorCopyKey(errorKey);
    if (copyKey != null) {
      return localize(copyKey as TranslationKeys);
    }
  }

  return <UnclassifiedError json={json} text={text} message={message} />;
};

export default Error;
