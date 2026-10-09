import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { math } from 'micromark-extension-llm-math';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { directive } from 'micromark-extension-directive';
import { decodeString } from 'micromark-util-decode-string';
import { directiveFromMarkdown } from 'mdast-util-directive';
import { Constants, ContentTypes } from 'librechat-data-provider';

const UI_RESOURCE_PATTERN = /\\ui\{[\w]+(?:,[\w]+)*\}/g;
const CITATION_CLEANUP = /\\ue20[0-46]|[\ue200-\ue204\ue206]/g;
const STANDALONE_SUFFIX = /turn(\d+)(search|image|news|video|ref|file)(\d+)/y;
const MARKDOWN_ESCAPE_OR_REFERENCE = /\\(.)|&(#(?:\d{1,7}|[xX][\dA-Fa-f]{1,6})|[\dA-Za-z]{1,31});/g;
const TEXT_BOUNDARY = '\0';

type MarkdownNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};

type SourceSegment = {
  decodedStart: number;
  decodedEnd: number;
  sourceStart: number;
  sourceEnd: number;
  literal: boolean;
};

type CitationToken = {
  code: number;
  start: number;
  end: number;
  line: number;
  literal: boolean;
};

type CitationMatch = { start: number; end: number };

type CitationOutputSegment =
  | { kind: 'text'; intervals: Array<[number, number]> }
  | { kind: 'nontext' };

function collectCitationTokens(value: string) {
  const tokens: CitationToken[] = [];
  const allStandalone: CitationMatch[] = [];
  const standalone: CitationMatch[] = [];
  let lastCompositeOpen = -1;
  let lastCompositeClose = -1;
  let line = 0;

  for (let index = 0; index < value.length; ) {
    let code = -1;
    let end = index + 1;
    let literal = false;
    const characterCode = value.charCodeAt(index);
    if (characterCode >= 0xe200 && characterCode <= 0xe206 && characterCode !== 0xe205) {
      code = characterCode - 0xe200;
    } else if (
      value.charCodeAt(index) === 92 &&
      value.startsWith('ue20', index + 1) &&
      index + 5 < value.length
    ) {
      const digit = value.charCodeAt(index + 5) - 48;
      if (digit >= 0 && digit <= 6 && digit !== 5) {
        code = digit;
        end = index + 6;
        literal = true;
      }
    }

    if (code < 0) {
      if (
        characterCode === 10 ||
        characterCode === 13 ||
        characterCode === 0x2028 ||
        characterCode === 0x2029
      ) {
        line++;
      }
      index++;
      continue;
    }

    const token = { code, start: index, end, line, literal };
    tokens.push(token);
    if (code === 2) {
      STANDALONE_SUFFIX.lastIndex = end;
      const suffix = STANDALONE_SUFFIX.exec(value);
      if (suffix) {
        const citation = { start: index, end: STANDALONE_SUFFIX.lastIndex };
        allStandalone.push(citation);
        if (lastCompositeOpen === -1 || lastCompositeClose > lastCompositeOpen) {
          standalone.push(citation);
        }
      }
    } else if (code === 0) {
      lastCompositeOpen = index;
    } else if (code === 1) {
      lastCompositeClose = index;
    }
    index = end;
  }

  return { tokens, allStandalone, standalone };
}

function pairCitationRanges(tokens: CitationToken[], openCode: number, closeCode: number) {
  const openers = tokens.filter((token) => token.code === openCode);
  const closers = tokens.filter((token) => token.code === closeCode);
  const ranges: CitationMatch[] = [];
  let closeIndex = 0;
  for (const opener of openers) {
    while (
      closers[closeIndex] &&
      (closers[closeIndex].line < opener.line ||
        (closers[closeIndex].line === opener.line && closers[closeIndex].start < opener.end))
    ) {
      closeIndex++;
    }
    const closer = closers[closeIndex];
    if (closer?.line === opener.line) {
      ranges.push({ start: opener.start, end: closer.end });
    }
  }
  return ranges;
}

/** Model the citation plugin's emitted text nodes without its unbounded wildcard regexes. */
function applyCitationTextBoundaries(value: string, sourceSegments: SourceSegment[]) {
  const { tokens, allStandalone, standalone } = collectCitationTokens(value);
  const highlighted = pairCitationRanges(tokens, 3, 4);
  const composite = pairCitationRanges(tokens, 0, 1);
  const output: CitationOutputSegment[] = [];
  let tokenIndex = 0;

  const addText = (start: number, end: number, highlightedText = false) => {
    const intervals: Array<[number, number]> = [];
    let cursor = start;
    while (tokens[tokenIndex]?.end <= start) {
      tokenIndex++;
    }
    while (tokens[tokenIndex]?.start < end) {
      const token = tokens[tokenIndex++];
      const remove = highlightedText
        ? token.literal && (token.code === 3 || token.code === 4)
        : true;
      if (remove) {
        if (cursor < token.start) {
          intervals.push([cursor, token.start]);
        }
        cursor = token.end;
      }
    }
    if (cursor < end) {
      intervals.push([cursor, end]);
    }
    if (intervals.length > 0 || highlightedText) {
      output.push({ kind: 'text', intervals });
    }
  };

  let highlightedIndex = 0;
  let compositeIndex = 0;
  let standaloneIndex = 0;
  let compositeCitationIndex = 0;
  let position = 0;
  while (position < value.length) {
    while (highlighted[highlightedIndex]?.start < position) {
      highlightedIndex++;
    }
    while (composite[compositeIndex]?.start < position) {
      compositeIndex++;
    }
    while (standalone[standaloneIndex]?.start < position) {
      standaloneIndex++;
    }

    const highlightedMatch = highlighted[highlightedIndex];
    const compositeMatch = composite[compositeIndex];
    const standaloneMatch = standalone[standaloneIndex];
    let type: 'highlighted' | 'composite' | 'standalone' | undefined;
    let next = highlightedMatch;
    if (next) {
      type = 'highlighted';
    }
    if (compositeMatch && (!next || compositeMatch.start < next.start)) {
      type = 'composite';
      next = compositeMatch;
    }
    if (standaloneMatch && (!next || standaloneMatch.start < next.start)) {
      type = 'standalone';
      next = standaloneMatch;
    }
    if (!next || !type) {
      addText(position, value.length);
      break;
    }

    if (next.start > position) {
      addText(position, next.start);
    }
    if (type === 'highlighted') {
      addText(next.start, next.end, true);
      highlightedIndex++;
    } else if (type === 'standalone') {
      output.push({ kind: 'nontext' });
      standaloneIndex++;
    } else {
      while (allStandalone[compositeCitationIndex]?.start < next.start) {
        compositeCitationIndex++;
      }
      const citation = allStandalone[compositeCitationIndex];
      if (citation && citation.end <= next.end) {
        output.push({ kind: 'nontext' });
      }
      compositeIndex++;
    }
    position = next.end;
  }

  if (output.length === 0) {
    tokenIndex = 0;
    addText(0, value.length);
  }

  let transformedValue = '';
  const transformedSegments: SourceSegment[] = [];
  let sourceSegmentIndex = 0;
  const appendInterval = ([start, end]: [number, number]) => {
    while (sourceSegments[sourceSegmentIndex]?.decodedEnd <= start) {
      sourceSegmentIndex++;
    }
    let index = sourceSegmentIndex;
    while (sourceSegments[index]?.decodedStart < end) {
      const segment = sourceSegments[index];
      const sliceStart = Math.max(start, segment.decodedStart);
      const sliceEnd = Math.min(end, segment.decodedEnd);
      if (sliceStart < sliceEnd) {
        const decodedStart = transformedValue.length;
        transformedValue += value.slice(sliceStart, sliceEnd);
        const sourceStart = segment.literal
          ? segment.sourceStart + sliceStart - segment.decodedStart
          : segment.sourceStart;
        const sourceEnd = segment.literal
          ? segment.sourceStart + sliceEnd - segment.decodedStart
          : segment.sourceEnd;
        const previous = transformedSegments[transformedSegments.length - 1];
        if (
          segment.literal &&
          previous?.literal &&
          previous.decodedEnd === decodedStart &&
          previous.sourceEnd === sourceStart
        ) {
          previous.decodedEnd = transformedValue.length;
          previous.sourceEnd = sourceEnd;
        } else {
          transformedSegments.push({
            decodedStart,
            decodedEnd: transformedValue.length,
            sourceStart,
            sourceEnd,
            literal: segment.literal,
          });
        }
      }
      index++;
    }
    sourceSegmentIndex = Math.max(sourceSegmentIndex, index - 1);
  };

  output.forEach((segment, index) => {
    if (index > 0) {
      transformedValue += TEXT_BOUNDARY;
    }
    if (segment.kind === 'text') {
      segment.intervals.forEach(appendInterval);
    }
  });
  return { value: transformedValue, segments: transformedSegments };
}

function decodeTextWithSourceSpans(source: string) {
  let value = '';
  const segments: SourceSegment[] = [];
  let cursor = 0;
  MARKDOWN_ESCAPE_OR_REFERENCE.lastIndex = 0;

  const appendLiteral = (start: number, end: number) => {
    if (start === end) {
      return;
    }
    const decodedStart = value.length;
    value += source.slice(start, end);
    const previous = segments[segments.length - 1];
    if (previous?.literal && previous.decodedEnd === decodedStart && previous.sourceEnd === start) {
      previous.decodedEnd = value.length;
      previous.sourceEnd = end;
      return;
    }
    segments.push({
      decodedStart,
      decodedEnd: value.length,
      sourceStart: start,
      sourceEnd: end,
      literal: true,
    });
  };

  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_ESCAPE_OR_REFERENCE.exec(source)) != null) {
    appendLiteral(cursor, match.index);
    const decoded = decodeString(match[0]);
    if (decoded === match[0]) {
      appendLiteral(match.index, MARKDOWN_ESCAPE_OR_REFERENCE.lastIndex);
    } else {
      const decodedStart = value.length;
      value += decoded;
      segments.push({
        decodedStart,
        decodedEnd: value.length,
        sourceStart: match.index,
        sourceEnd: MARKDOWN_ESCAPE_OR_REFERENCE.lastIndex,
        literal: false,
      });
    }
    cursor = MARKDOWN_ESCAPE_OR_REFERENCE.lastIndex;
  }
  appendLiteral(cursor, source.length);
  return applyCitationTextBoundaries(value, segments);
}

function mapDecodedRange(
  segments: SourceSegment[],
  decodedStart: number,
  decodedEnd: number,
  fromIndex: number,
): { range: [number, number]; segmentIndex: number } | null {
  let firstIndex = fromIndex;
  while (segments[firstIndex]?.decodedEnd <= decodedStart) {
    firstIndex++;
  }
  const first = segments[firstIndex];
  if (!first || decodedStart < first.decodedStart) {
    return null;
  }

  let lastIndex = firstIndex;
  while (segments[lastIndex]?.decodedEnd < decodedEnd) {
    lastIndex++;
  }
  const last = segments[lastIndex];
  if (!last || decodedEnd <= last.decodedStart) {
    return null;
  }

  const sourceStart = first.literal
    ? first.sourceStart + decodedStart - first.decodedStart
    : first.sourceStart;
  const sourceEnd = last.literal
    ? last.sourceStart + decodedEnd - last.decodedStart
    : last.sourceEnd;
  return { range: [sourceStart, sourceEnd], segmentIndex: lastIndex };
}

function collectMarkerRanges(root: MarkdownNode, source: string, ranges: Array<[number, number]>) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as MarkdownNode;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === 'text' && start != null && end != null) {
      const decoded = decodeTextWithSourceSpans(source.slice(start, end));
      UI_RESOURCE_PATTERN.lastIndex = 0;
      let segmentCursor = 0;
      let match: RegExpExecArray | null;
      while ((match = UI_RESOURCE_PATTERN.exec(decoded.value)) != null) {
        const mapped = mapDecodedRange(
          decoded.segments,
          match.index,
          match.index + match[0].length,
          segmentCursor,
        );
        if (mapped) {
          segmentCursor = mapped.segmentIndex;
          ranges.push([start + mapped.range[0], start + mapped.range[1]]);
        }
      }
    }
    if (node.type === 'textDirective') {
      continue;
    }
    if (node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }
  }
}

function findUIResourceMarkerRanges(text: string): Array<[number, number]> {
  if (
    (!text.includes('\\') && !text.includes('&')) ||
    !decodeString(text).replace(CITATION_CLEANUP, '').includes('\\ui{')
  ) {
    return [];
  }
  const ranges: Array<[number, number]> = [];
  collectMarkerRanges(
    fromMarkdown(text, {
      extensions: [gfm(), directive(), math({ singleDollarTextMath: false })],
      mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown(), mathFromMarkdown()],
    }) as unknown as MarkdownNode,
    text,
    ranges,
  );
  return ranges;
}

function removeSourceRanges(text: string, ranges: Array<[number, number]>) {
  let result = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    result += text.slice(cursor, start);
    cursor = end;
  }
  return result + text.slice(cursor);
}

/** Remove MCP-UI markers only from Markdown text nodes visited by the renderer plugin. */
export function stripUIResourceMarkers(text: string): string;
export function stripUIResourceMarkers(text: undefined): undefined;
export function stripUIResourceMarkers(text: string | undefined): string | undefined;
export function stripUIResourceMarkers(text: string | undefined): string | undefined {
  if (text == null) {
    return text;
  }
  const ranges = findUIResourceMarkerRanges(text);
  return ranges.length === 0 ? text : removeSourceRanges(text, ranges);
}

/** Sanitize only the portion of a legacy message that the client renders as Markdown. */
export function stripMessageUIResourceMarkers(
  text: string | undefined,
  error?: unknown,
): string | undefined {
  if (text == null || error) {
    return text;
  }
  const thinkingMatch = /:::thinking[\s\S]*?:::/.exec(text);
  if (!thinkingMatch) {
    return stripUIResourceMarkers(text);
  }
  const start = thinkingMatch.index;
  const end = start + thinkingMatch[0].length;
  const regularContent = text.slice(0, start) + text.slice(end);
  const renderedStart = regularContent.length - regularContent.trimStart().length;
  const renderedEnd = regularContent.trimEnd().length;
  const regularRanges = findUIResourceMarkerRanges(
    regularContent.slice(renderedStart, renderedEnd),
  );
  if (regularRanges.length === 0) {
    return text;
  }
  const sourceRanges: Array<[number, number]> = [];
  const blockLength = end - start;
  for (const renderedRange of regularRanges) {
    const rangeStart = renderedRange[0] + renderedStart;
    const rangeEnd = renderedRange[1] + renderedStart;
    if (rangeEnd <= start) {
      sourceRanges.push([rangeStart, rangeEnd]);
    } else if (rangeStart >= start) {
      sourceRanges.push([rangeStart + blockLength, rangeEnd + blockLength]);
    } else {
      sourceRanges.push([rangeStart, start], [end, rangeEnd + blockLength]);
    }
  }
  return removeSourceRanges(text, sourceRanges);
}

function sanitizeTextPart(part: Record<string, unknown>): unknown {
  if (typeof part.text === 'string') {
    const text = stripUIResourceMarkers(part.text);
    return text === part.text ? part : { ...part, text };
  }
  if (part.text != null && typeof part.text === 'object') {
    const textData = part.text as Record<string, unknown>;
    if (typeof textData.value === 'string') {
      const value = stripUIResourceMarkers(textData.value);
      return value === textData.value ? part : { ...part, text: { ...textData, value } };
    }
  }
  return part;
}

type ContentFrame = {
  content: unknown[];
  sanitizeTextParts: boolean;
  index: number;
  result: unknown[] | null;
  onComplete: (content: unknown[]) => void;
};

function updateFramePart(
  frame: ContentFrame,
  index: number,
  originalPart: unknown,
  sanitizedPart: unknown,
) {
  if (sanitizedPart === originalPart) {
    return;
  }
  frame.result ??= [...frame.content];
  frame.result[index] = sanitizedPart;
}

/** Sanitize assistant text parts, including arbitrarily nested persisted subagent content. */
export function sanitizeUIResourceContent(content: unknown, sanitizeTextParts = true): unknown {
  if (!Array.isArray(content)) {
    return content;
  }

  let sanitizedContent = content;
  const stack: ContentFrame[] = [
    {
      content,
      sanitizeTextParts,
      index: 0,
      result: null,
      onComplete: (result) => {
        sanitizedContent = result;
      },
    },
  ];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.content.length) {
      stack.pop();
      frame.onComplete(frame.result ?? frame.content);
      continue;
    }

    const index = frame.index++;
    const part = frame.content[index];
    if (part == null || typeof part !== 'object') {
      continue;
    }

    let sanitizedPart: unknown = part;
    const record = part as Record<string, unknown>;
    if (frame.sanitizeTextParts && record.type === ContentTypes.TEXT) {
      sanitizedPart = sanitizeTextPart(record);
    }

    const current = sanitizedPart as Record<string, unknown>;
    if (current.tool_call == null || typeof current.tool_call !== 'object') {
      updateFramePart(frame, index, part, sanitizedPart);
      continue;
    }

    const toolCall = current.tool_call as Record<string, unknown>;
    let sanitizedToolCall = toolCall;
    if (toolCall.name === Constants.SUBAGENT && typeof toolCall.output === 'string') {
      const output = stripUIResourceMarkers(toolCall.output);
      if (output !== toolCall.output) {
        sanitizedToolCall = { ...sanitizedToolCall, output };
      }
    }

    if (Array.isArray(toolCall.subagent_content)) {
      const originalSubagentContent = toolCall.subagent_content;
      stack.push({
        content: originalSubagentContent,
        sanitizeTextParts: true,
        index: 0,
        result: null,
        onComplete: (subagentContent) => {
          if (subagentContent !== originalSubagentContent) {
            sanitizedToolCall = { ...sanitizedToolCall, subagent_content: subagentContent };
          }
          if (sanitizedToolCall !== toolCall) {
            sanitizedPart = { ...current, tool_call: sanitizedToolCall };
          }
          updateFramePart(frame, index, part, sanitizedPart);
        },
      });
      continue;
    }

    if (sanitizedToolCall !== toolCall) {
      sanitizedPart = { ...current, tool_call: sanitizedToolCall };
    }
    updateFramePart(frame, index, part, sanitizedPart);
  }

  return sanitizedContent;
}
