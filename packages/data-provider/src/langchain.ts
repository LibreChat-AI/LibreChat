/**
 * LangChain classifies a provider failure by mutating the error: it stamps `lc_error_code` and
 * appends `\n\nTroubleshooting URL: <docs url>\n` to the message. Both halves are handled here
 * because the server strips the URL before persisting the message, while the client still reads the
 * code back out of messages persisted before it did.
 */
const LANGCHAIN = 'langchain';
const ERROR_PATH = '/errors/';
const TROUBLESHOOTING_LABEL = 'Troubleshooting URL:';
const WHITESPACE = /\s/;

/** Provider errors cross untyped boundaries, so a `message` is not guaranteed to be a string. */
function toMessageText(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  return message == null ? '' : String(message);
}

function isErrorCodeCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return character === '_' || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function findTokenEnd(text: string, start: number, limit = text.length): number {
  let end = start;
  while (end < limit && !WHITESPACE.test(text[end])) {
    end += 1;
  }
  return end;
}

function findErrorCode(
  text: string,
  searchableText: string,
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  const langChainIndex = searchableText.indexOf(LANGCHAIN, start);
  if (langChainIndex < 0 || langChainIndex >= end) {
    return undefined;
  }

  let errorCode: { start: number; end: number } | undefined;
  let pathIndex = searchableText.indexOf(ERROR_PATH, langChainIndex + LANGCHAIN.length);
  while (pathIndex >= 0 && pathIndex < end) {
    const codeStart = pathIndex + ERROR_PATH.length;
    let codeEnd = codeStart;
    while (codeEnd < end && isErrorCodeCharacter(text[codeEnd])) {
      codeEnd += 1;
    }
    if (codeEnd > codeStart) {
      errorCode = { start: codeStart, end: codeEnd };
    }
    pathIndex = searchableText.indexOf(ERROR_PATH, Math.max(codeStart, codeEnd));
  }

  return errorCode;
}

/** Removes LangChain's appended docs URL so provider text carries no third-party attribution. */
export function stripLangChainTroubleshootingUrl(message: unknown): string {
  const text = toMessageText(message);
  const parts: string[] = [];
  let copiedUntil = 0;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const labelStart = text.indexOf(TROUBLESHOOTING_LABEL, searchFrom);
    if (labelStart < 0) {
      break;
    }

    let matchStart = labelStart;
    while (matchStart > copiedUntil && WHITESPACE.test(text[matchStart - 1])) {
      matchStart -= 1;
    }

    let urlStart = labelStart + TROUBLESHOOTING_LABEL.length;
    while (urlStart < text.length && WHITESPACE.test(text[urlStart])) {
      urlStart += 1;
    }
    if (!text.startsWith('https://', urlStart) && !text.startsWith('http://', urlStart)) {
      searchFrom = urlStart;
      continue;
    }

    const urlEnd = findTokenEnd(text, urlStart);
    const errorCode = findErrorCode(text, text, urlStart, urlEnd);
    if (errorCode == null) {
      searchFrom = urlEnd;
      continue;
    }

    let matchEnd = errorCode.end;
    if (text[matchEnd] === '/') {
      matchEnd += 1;
    }
    while (matchEnd < text.length && WHITESPACE.test(text[matchEnd])) {
      matchEnd += 1;
    }

    parts.push(text.slice(copiedUntil, matchStart), ' ');
    copiedUntil = matchEnd;
    searchFrom = matchEnd;
  }

  parts.push(text.slice(copiedUntil));
  return parts.join('').trim();
}

/** The classification LangChain encoded in the docs URL it appended, when the text carries one. */
export function parseLangChainErrorCode(message: unknown): string | undefined {
  const text = toMessageText(message);
  const searchableText = text.toLowerCase();
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const langChainIndex = searchableText.indexOf(LANGCHAIN, searchFrom);
    if (langChainIndex < 0) {
      return undefined;
    }
    const tokenEnd = findTokenEnd(text, langChainIndex);
    const errorCode = findErrorCode(text, searchableText, langChainIndex, tokenEnd);
    if (errorCode != null) {
      return text.slice(errorCode.start, errorCode.end).toUpperCase();
    }
    searchFrom = tokenEnd + 1;
  }

  return undefined;
}
