import { useCallback, useEffect, useMemo, useRef } from 'react';
import copy from 'copy-to-clipboard';
import { useRecoilValue } from 'recoil';
import { ContentTypes, SearchResultData } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { MarkdownVariant, RichTextMode } from '~/utils/richtext';
import {
  SPAN_REGEX,
  CLEANUP_REGEX,
  COMPOSITE_REGEX,
  STANDALONE_PATTERN,
  INVALID_CITATION_REGEX,
} from '~/utils/citations';
import { markdownToHtml } from '~/utils/richtext';
import store from '~/store';

type Source = {
  link: string;
  title: string;
  attribution?: string;
  type: string;
  typeIndex: number;
  citationKey: string; // Used for deduplication
};

const refTypeMap: Record<string, string> = {
  search: 'organic',
  ref: 'references',
  news: 'topStories',
  /** File-search sources share the `references` collection, as `useCitation` reads them. */
  file: 'references',
  image: 'images',
  video: 'videos',
};

type ClipboardSource = Partial<Pick<TMessage, 'text' | 'content'>> & {
  searchResults?: { [key: string]: SearchResultData };
  /**
   * Also place the markdown rendered as HTML on the clipboard, for paste
   * targets that ignore Markdown. The mode selects the message renderer to
   * mirror; omitting it copies plain text only.
   */
  richText?: RichTextMode;
};

function getPartText(part: TMessageContentParts): string {
  if (part?.type !== ContentTypes.TEXT) {
    return '';
  }

  return typeof part.text === 'string' ? part.text : (part.text?.value ?? '');
}

function getMessageParts({ text, content }: Partial<Pick<TMessage, 'text' | 'content'>>): string[] {
  if (!Array.isArray(content) || content.length === 0) {
    const messageText = text ?? '';
    return messageText.length > 0 ? [messageText] : [];
  }

  const parts: string[] = [];
  for (const part of content) {
    const partText = getPartText(part);
    if (partText.length > 0) {
      parts.push(partText);
    }
  }

  return parts;
}

export function serializeMessageForClipboard(
  source: Partial<Pick<TMessage, 'text' | 'content'>>,
): string {
  return getMessageParts(source).join('\n');
}

type CitationSegment = {
  text: string;
  /**
   * Generated citation markers in this segment, which must not resolve as
   * markdown references. Scoped per segment: each is its own document, so a
   * legitimate `[1]` reference in one part is unaffected by a citation numbered
   * `1` in another.
   */
  reserved: ReadonlySet<string>;
};

/** One entry per rendered text part, plus the citation footer when there is one. */
type ClipboardContent = CitationSegment[];

function buildClipboardContent({
  text,
  content,
  searchResults,
}: ClipboardSource): ClipboardContent {
  const parts = getMessageParts({ text, content });

  if (!searchResults || Object.keys(searchResults).length === 0) {
    return parts.map((part) => ({
      text: part.replace(INVALID_CITATION_REGEX, '').replace(CLEANUP_REGEX, ''),
      reserved: EMPTY_RESERVED,
    }));
  }

  const processor = createCitationProcessor(searchResults);
  const segments = parts.map((part) => processor.process(part));

  if (processor.citations.size === 0) {
    return segments;
  }

  const sortedCitations = Array.from(processor.citations.entries()).sort(
    (a, b) => a[1].referenceNumber - b[1].referenceNumber,
  );
  const citationList = sortedCitations
    .map(([, citation]) => `[${citation.referenceNumber}] ${citation.link}\n`)
    .join('');

  /**
   * The footer is its own segment rather than an addition to the last one: a
   * segment ending in an unclosed construct, an interrupted code fence most of
   * all, would otherwise swallow the sources into it.
   */
  segments.push({
    text: `\nCitations:\n${citationList}`,
    reserved: new Set(sortedCitations.map(([, citation]) => `${citation.referenceNumber}`)),
  });

  return segments;
}

function buildClipboardText(source: ClipboardSource): string {
  return buildClipboardContent(source)
    .map((segment) => segment.text)
    .join('\n');
}

export function hasCopyableText(source: ClipboardSource): boolean {
  return buildClipboardText(source).trim().length > 0;
}

const EMPTY_RESERVED: ReadonlySet<string> = new Set();

function buildCopyOptions(
  segments: ClipboardContent,
  richText: RichTextMode | undefined,
): Parameters<typeof copy>[1] {
  if (!richText) {
    return { format: 'text/plain' };
  }

  let html = '';
  for (const segment of segments) {
    const serialized = markdownToHtml(segment.text, { ...richText, reserved: segment.reserved });
    if (serialized.length > 0) {
      html += html.length > 0 ? `\n${serialized}` : serialized;
    }
  }

  if (html.length === 0) {
    return { format: 'text/plain' };
  }

  return {
    format: 'text/plain',
    onCopy: (clipboardData) => {
      (clipboardData as DataTransfer | null)?.setData('text/html', html);
    },
  };
}

export default function useCopyToClipboard({
  text,
  content,
  searchResults,
  richText,
}: ClipboardSource) {
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const copyToClipboard = useCallback(
    (setIsCopied: React.Dispatch<React.SetStateAction<boolean>>): boolean => {
      const clipboardContent = buildClipboardContent({ text, content, searchResults });
      const clipboardText = clipboardContent.map((segment) => segment.text).join('\n');

      if (clipboardText.trim().length === 0) {
        return false;
      }

      if (!copy(clipboardText, buildCopyOptions(clipboardContent, richText))) {
        return false;
      }

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }

      setIsCopied(true);
      copyTimeoutRef.current = setTimeout(() => {
        setIsCopied(false);
      }, 3000);

      return true;
    },
    [text, content, searchResults, richText],
  );

  return copyToClipboard;
}

type MessageClipboardSource = ClipboardSource &
  Partial<Pick<TMessage, 'isCreatedByUser' | 'error'>> & {
    /** Set by callers that render through a fixed renderer rather than the authorship default. */
    variant?: MarkdownVariant;
  };

/**
 * Copies a message honoring the user's rich text preference. Kept apart from
 * `useCopyToClipboard` so the plain copies (share links, API keys, callback
 * URLs) never get wrapped in markup.
 *
 * A user message is only rendered as markdown when `enableUserMsgMarkdown` is
 * on, so with it off the HTML flavor is skipped: otherwise text that reads as
 * literal on screen would arrive formatted in the paste target. User turns that
 * do render go through `MarkdownLite`, which neither enables directives nor
 * preprocesses LaTeX, hence the lighter mode.
 */
export function useCopyMessageToClipboard({
  isCreatedByUser,
  error,
  variant,
  ...source
}: MessageClipboardSource) {
  const copyRichText = useRecoilValue(store.copyRichText);
  const enableUserMsgMarkdown = useRecoilValue(store.enableUserMsgMarkdown);
  const latexParsing = useRecoilValue(store.LaTeXParsing);
  const user = useRecoilValue(store.user);

  const richText = useMemo((): RichTextMode | undefined => {
    /** An errored row is rendered by `ErrorMessage`, not as markdown at all. */
    if (!copyRichText || error === true) {
      return undefined;
    }
    if (variant === 'lite') {
      return { variant: 'lite', latex: false, userId: user?.id };
    }
    if (variant === 'full' || isCreatedByUser !== true) {
      return { variant: 'full', latex: latexParsing, userId: user?.id };
    }
    return enableUserMsgMarkdown ? { variant: 'lite', latex: false, userId: user?.id } : undefined;
  }, [
    copyRichText,
    enableUserMsgMarkdown,
    error,
    isCreatedByUser,
    latexParsing,
    user?.id,
    variant,
  ]);

  return useCopyToClipboard({ ...source, richText });
}

/**
 * Process citations in the text and format them properly
 */
/**
 * Citation numbering is shared across every text part of a message, while each
 * part is formatted on its own: on screen each renders through its own Markdown
 * instance, so a construct must not span two of them.
 */
function createCitationProcessor(searchResults: { [key: string]: SearchResultData }) {
  // Maps citation keys to their info including reference numbers
  const citations = new Map<
    string,
    {
      referenceNumber: number;
      link: string;
      title?: string;
      source: Source;
    }
  >();

  // Map to track URLs to citation keys for deduplication
  const urlToCitationKey = new Map<string, string>();

  let nextReferenceNumber = 1;

  const process = (text: string): CitationSegment => {
    /** Markers emitted into this text, which must not resolve as references. */
    const reserved = new Set<string>();
    let formattedText = text;

    // Step 1: Process highlighted text first (simplify by just making it bold in markdown)
    formattedText = formattedText.replace(SPAN_REGEX, (match) => {
      const text = match.replace(/\\ue203|\\ue204|\ue203|\ue204/g, '');
      return `**${text}**`;
    });

    // Step 2: Find all standalone citations and composite citation blocks
    const allCitations: Array<{
      turn: string;
      type: string;
      index: string;
      position: number;
      fullMatch: string;
      isComposite: boolean;
    }> = [];

    // Find standalone citations
    let standaloneMatch: RegExpExecArray | null;
    const standaloneCopy = new RegExp(STANDALONE_PATTERN.source, 'g');
    while ((standaloneMatch = standaloneCopy.exec(formattedText)) !== null) {
      allCitations.push({
        turn: standaloneMatch[1],
        type: standaloneMatch[2],
        index: standaloneMatch[3],
        position: standaloneMatch.index,
        fullMatch: standaloneMatch[0],
        isComposite: false,
      });
    }

    // Find composite citation blocks
    let compositeMatch: RegExpExecArray | null;
    const compositeCopy = new RegExp(COMPOSITE_REGEX.source, 'g');
    while ((compositeMatch = compositeCopy.exec(formattedText)) !== null) {
      const block = compositeMatch[0];
      const blockStart = compositeMatch.index;

      // Extract individual citations within the composite block
      let citationMatch: RegExpExecArray | null;
      const citationPattern = new RegExp(STANDALONE_PATTERN.source, 'g');
      while ((citationMatch = citationPattern.exec(block)) !== null) {
        allCitations.push({
          turn: citationMatch[1],
          type: citationMatch[2],
          index: citationMatch[3],
          position: blockStart + citationMatch.index,
          fullMatch: block, // Store the full composite block
          isComposite: true,
        });
      }
    }

    // Sort citations by their position in the text
    allCitations.sort((a, b) => a.position - b.position);

    // Step 3: Process each citation and build the reference mapping
    const processedCitations = new Set<string>();
    const replacements: Array<[string, string]> = [];
    const compositeCitationsMap = new Map<string, number[]>();

    for (const citation of allCitations) {
      const { turn, type, index, fullMatch, isComposite } = citation;
      const searchData = searchResults[turn];

      if (!searchData) continue;

      const dataType = refTypeMap[type.toLowerCase()] || type.toLowerCase();
      const idx = parseInt(index, 10);

      // Skip if no matching data
      if (!searchData[dataType] || !searchData[dataType][idx]) {
        continue;
      }

      // Get source data
      const sourceData = searchData[dataType][idx];
      const sourceUrl = sourceData.link || '';

      // Skip if no link
      if (!sourceUrl) continue;

      // Check if this URL has already been cited
      let citationKey = urlToCitationKey.get(sourceUrl);

      // If not, create a new citation key
      if (!citationKey) {
        citationKey = `${turn}-${dataType}-${idx}`;
        urlToCitationKey.set(sourceUrl, citationKey);
      }

      const source: Source = {
        link: sourceUrl,
        title: sourceData.title || sourceData.name || '',
        attribution: sourceData.attribution || sourceData.source || '',
        type: dataType,
        typeIndex: idx,
        citationKey,
      };

      // Skip if already processed this citation in a composite block
      if (isComposite && processedCitations.has(fullMatch)) {
        continue;
      }

      let referenceText = '';

      // Check if this source has been cited before
      let existingCitation = citations.get(citationKey);

      if (!existingCitation) {
        // New citation
        existingCitation = {
          referenceNumber: nextReferenceNumber++,
          link: source.link,
          title: source.title,
          source,
        };
        citations.set(citationKey, existingCitation);
      }

      if (existingCitation) {
        // For composite blocks, we need to find all citations and create a combined reference
        if (isComposite) {
          // Parse all citations in this composite block if we haven't processed it yet
          if (!processedCitations.has(fullMatch)) {
            const compositeCitations: number[] = [];
            let citationMatch: RegExpExecArray | null;
            const citationPattern = new RegExp(STANDALONE_PATTERN.source, 'g');

            while ((citationMatch = citationPattern.exec(fullMatch)) !== null) {
              const cTurn = citationMatch[1];
              const cType = citationMatch[2];
              const cIndex = citationMatch[3];
              const cDataType = refTypeMap[cType.toLowerCase()] || cType.toLowerCase();

              const cSource = searchResults[cTurn]?.[cDataType]?.[parseInt(cIndex, 10)];
              if (cSource && cSource.link) {
                // Check if we've already created a citation for this URL
                const cUrl = cSource.link;
                let cKey = urlToCitationKey.get(cUrl);

                if (!cKey) {
                  cKey = `${cTurn}-${cDataType}-${cIndex}`;
                  urlToCitationKey.set(cUrl, cKey);
                }

                let cCitation = citations.get(cKey);

                if (!cCitation) {
                  cCitation = {
                    referenceNumber: nextReferenceNumber++,
                    link: cSource.link,
                    title: cSource.title || cSource.name || '',
                    source: {
                      link: cSource.link,
                      title: cSource.title || cSource.name || '',
                      attribution: cSource.attribution || cSource.source || '',
                      type: cDataType,
                      typeIndex: parseInt(cIndex, 10),
                      citationKey: cKey,
                    },
                  };
                  citations.set(cKey, cCitation);
                }

                if (cCitation) {
                  compositeCitations.push(cCitation.referenceNumber);
                }
              }
            }

            // Sort and deduplicate the composite citations
            const uniqueSortedCitations = [...new Set(compositeCitations)].sort((a, b) => a - b);

            // Create combined reference numbers for all citations in this composite
            for (const num of uniqueSortedCitations) {
              reserved.add(`${num}`);
            }
            referenceText =
              uniqueSortedCitations.length > 0
                ? uniqueSortedCitations.map((num) => `[${num}]`).join('')
                : '';

            processedCitations.add(fullMatch);
            compositeCitationsMap.set(fullMatch, uniqueSortedCitations);
            replacements.push([fullMatch, referenceText]);
          }

          // Skip further processing since we've handled the entire composite block
          continue;
        } else {
          // Single citation
          reserved.add(`${existingCitation.referenceNumber}`);
          referenceText = `[${existingCitation.referenceNumber}]`;
          replacements.push([fullMatch, referenceText]);
        }
      }
    }

    // Step 4: Apply all replacements (from longest to shortest to avoid nested replacement issues)
    replacements.sort((a, b) => b[0].length - a[0].length);
    for (const [pattern, replacement] of replacements) {
      formattedText = formattedText.replace(pattern, replacement);
    }

    // Step 5: Remove any orphaned composite blocks at the end of the text
    // This prevents the [1][2][3][4] list that might appear at the end if there's a composite there
    formattedText = formattedText.replace(/\n\s*\[\d+\](\[\d+\])*\s*$/g, '');

    // Step 6: Clean up any remaining citation markers
    formattedText = formattedText.replace(INVALID_CITATION_REGEX, '');
    formattedText = formattedText.replace(CLEANUP_REGEX, '');

    return { text: formattedText, reserved };
  };

  return { process, citations };
}
