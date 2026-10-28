import { visit } from 'unist-util-visit';
import type { Node } from 'unist';
import type { Citation, CitationNode } from './types';
import { SPAN_REGEX, STANDALONE_PATTERN, CLEANUP_REGEX, COMPOSITE_REGEX } from '~/utils/citations';

const compositeRefRegex = new RegExp(STANDALONE_PATTERN.source, 'g');

/**
 * Checks if a standalone marker is truly standalone (not inside a composite block).
 * A marker is inside a composite if there's an opening \ue200 without a closing \ue201 after it.
 *
 * Handles both literal text format ("\ue200") and actual Unicode (U+E200) by checking
 * for both and using the rightmost occurrence. This correctly handles:
 * - Pure literal format: "\ue200...\ue201"
 * - Pure Unicode format: "..."
 * - Mixed formats: "\ue200..." (different formats for open/close)
 */
function lastIndexBefore(text: string, needle: string, position: number): number {
  const fromIndex = position - needle.length;
  return fromIndex < 0 ? -1 : text.lastIndexOf(needle, fromIndex);
}

function isStandaloneMarker(text: string, position: number): boolean {
  // Find rightmost composite block start (either format), ending before `position`
  const lastUe200Literal = lastIndexBefore(text, '\\ue200', position);
  const lastUe200Char = lastIndexBefore(text, '\ue200', position);
  const lastUe200 = Math.max(lastUe200Literal, lastUe200Char);

  // Find rightmost composite block end (either format)
  const lastUe201Literal = lastIndexBefore(text, '\\ue201', position);
  const lastUe201Char = lastIndexBefore(text, '\ue201', position);
  const lastUe201 = Math.max(lastUe201Literal, lastUe201Char);

  // Standalone if: no opening marker OR closing marker appears after opening
  return lastUe200 === -1 || (lastUe201 !== -1 && lastUe201 > lastUe200);
}

/**
 * Find the next pattern match from the current position
 */
function findNextMatch(
  text: string,
  position: number,
): { type: string; match: RegExpExecArray | null; index: number } | null {
  // Reset regex lastIndex to start from current position
  SPAN_REGEX.lastIndex = position;
  COMPOSITE_REGEX.lastIndex = position;
  STANDALONE_PATTERN.lastIndex = position;

  // Find next occurrence of each pattern
  const spanMatch = SPAN_REGEX.exec(text);
  const compositeMatch = COMPOSITE_REGEX.exec(text);

  // For standalone, we need to check each match
  let standaloneMatch: RegExpExecArray | null = null;
  STANDALONE_PATTERN.lastIndex = position;

  // Find the first standalone match that's not inside a composite block
  let match: RegExpExecArray | null;
  while (!standaloneMatch && (match = STANDALONE_PATTERN.exec(text)) !== null) {
    if (isStandaloneMarker(text, match.index)) {
      standaloneMatch = match;
    }
  }

  // Find closest match
  let nextMatch: RegExpExecArray | null = null;
  let matchType = '';
  let matchIndex = -1;
  let typeIndex = -1;

  if (spanMatch && (!nextMatch || spanMatch.index < matchIndex || matchIndex === -1)) {
    nextMatch = spanMatch;
    matchType = 'span';
    matchIndex = spanMatch.index;
    // We can use a counter for typeIndex if needed
    typeIndex = 0;
  }

  if (compositeMatch && (!nextMatch || compositeMatch.index < matchIndex || matchIndex === -1)) {
    nextMatch = compositeMatch;
    matchType = 'composite';
    matchIndex = compositeMatch.index;
    typeIndex = 0;
  }

  if (standaloneMatch && (!nextMatch || standaloneMatch.index < matchIndex || matchIndex === -1)) {
    nextMatch = standaloneMatch;
    matchType = 'standalone';
    matchIndex = standaloneMatch.index;
    typeIndex = 0;
  }

  if (!nextMatch) return null;

  return { type: matchType, match: nextMatch, index: typeIndex };
}

function processTree(tree: Node) {
  visit(tree, 'text', (node, index, parent) => {
    const textNode = node as CitationNode;
    const parentNode = parent as CitationNode;

    if (typeof textNode.value !== 'string') return;

    const originalValue = textNode.value;
    const segments: Array<CitationNode> = [];

    // Single-pass processing through the string
    let currentPosition = 0;

    // Important change: Create a map to track citation IDs by their position
    // This ensures consistent IDs across multiple segments
    const citationIds = new Map<number, string>();
    const typeCounts = { span: 0, composite: 0, standalone: 0 };

    while (currentPosition < originalValue.length) {
      const nextMatchInfo = findNextMatch(originalValue, currentPosition);

      if (!nextMatchInfo) {
        // No more matches, add remaining content with cleanup
        const remainingText = originalValue.substring(currentPosition).replace(CLEANUP_REGEX, '');
        if (remainingText) {
          segments.push({ type: 'text', value: remainingText });
        }
        break;
      }

      const { type, match } = nextMatchInfo;
      const matchIndex = match!.index;
      const matchText = match![0];

      // Add cleaned text before this match
      if (matchIndex > currentPosition) {
        const textBeforeMatch = originalValue
          .substring(currentPosition, matchIndex)
          .replace(CLEANUP_REGEX, '');

        if (textBeforeMatch) {
          segments.push({ type: 'text', value: textBeforeMatch });
        }
      }

      // Generate a unique ID for this citation based on its position in the text
      const citationId = `${type}-${typeCounts[type as keyof typeof typeCounts]}-${matchIndex}`;
      citationIds.set(matchIndex, citationId);

      // Process based on match type
      switch (type) {
        case 'span': {
          const spanText = matchText;
          const cleanText = spanText.replace(/\\ue203|\\ue204/g, '');

          // Look ahead for associated citation
          let associatedCitationId: string | null = null;
          const endOfSpan = matchIndex + matchText.length;

          // Check if there's a citation right after this span
          const nextCitation = findNextMatch(originalValue, endOfSpan);
          if (
            nextCitation &&
            (nextCitation.type === 'standalone' || nextCitation.type === 'composite') &&
            nextCitation.match!.index - endOfSpan < 5
          ) {
            // Use the ID that will be generated for the next citation
            const nextIndex = nextCitation.match!.index;
            const nextType = nextCitation.type;
            associatedCitationId = `${nextType}-${typeCounts[nextType as keyof typeof typeCounts]}-${nextIndex}`;
          }

          segments.push({
            type: 'highlighted-text',
            data: {
              hName: 'highlighted-text',
              hProperties: { citationId: associatedCitationId },
            },
            children: [{ type: 'text', value: cleanText }],
          });

          typeCounts.span++;
          break;
        }

        case 'composite': {
          const compositeText = matchText;

          // Use a regular expression to extract reference indices
          compositeRefRegex.lastIndex = 0;
          let refMatch: RegExpExecArray | null;
          const citations: Array<Citation> = [];

          while ((refMatch = compositeRefRegex.exec(compositeText)) !== null) {
            const turn = Number(refMatch[1]);
            const refType = refMatch[2];
            const refIndex = Number(refMatch[3]);

            citations.push({
              turn,
              refType,
              index: refIndex,
            });
          }

          if (citations.length > 0) {
            segments.push({
              type: 'composite-citation',
              data: {
                hName: 'composite-citation',
                hProperties: {
                  citations,
                  citationId: citationId,
                },
              },
            });
          }

          typeCounts.composite++;
          break;
        }

        case 'standalone': {
          // Extract reference info
          const turn = Number(match![1]);
          const refType = match![2];
          const refIndex = Number(match![3]);

          segments.push({
            type: 'citation',
            data: {
              hName: 'citation',
              hProperties: {
                citation: {
                  turn,
                  refType,
                  index: refIndex,
                },
                citationType: 'standalone',
                citationId: citationId,
              },
            },
          });

          typeCounts.standalone++;
          break;
        }
      }

      // Move position forward
      currentPosition = matchIndex + matchText.length;
    }

    // Replace the original node with our segments or clean up the original
    if (segments.length > 0 && index !== undefined) {
      parentNode.children?.splice(index, 1, ...segments);
      return index + segments.length;
    } else if (textNode.value !== textNode.value.replace(CLEANUP_REGEX, '')) {
      // If we didn't create segments but there are markers to clean up
      textNode.value = textNode.value.replace(CLEANUP_REGEX, '');
    }
  });
}

export function unicodeCitation() {
  return (tree: Node) => {
    processTree(tree);
  };
}
