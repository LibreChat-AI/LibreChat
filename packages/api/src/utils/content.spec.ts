import { ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { Agents, PartMetadata, TMessageContentParts } from 'librechat-data-provider';
import type { ToolCall } from '@librechat/agents/langchain/messages/tool';
import { filterMalformedContentParts } from './content';

describe('filterMalformedContentParts', () => {
  describe('basic filtering', () => {
    it('should keep valid tool_call content parts', () => {
      const parts: TMessageContentParts[] = [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'test-id',
            name: 'test_function',
            type: ToolCallTypes.TOOL_CALL,
            args: '{}',
            progress: 1,
            output: 'result',
          },
        },
      ];

      const result = filterMalformedContentParts(parts);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(parts[0]);
    });

    it('should filter out malformed tool_call content parts without tool_call property', () => {
      const parts: TMessageContentParts[] = [
        { type: ContentTypes.TOOL_CALL } as TMessageContentParts,
      ];

      const result = filterMalformedContentParts(parts);
      expect(result).toHaveLength(0);
    });

    it('should keep other content types unchanged', () => {
      const parts: TMessageContentParts[] = [
        { type: ContentTypes.TEXT, text: 'Hello world' },
        { type: ContentTypes.THINK, think: 'Thinking...' },
      ];

      const result = filterMalformedContentParts(parts);
      expect(result).toHaveLength(2);
      expect(result).toEqual(parts);
    });

    it('filters empty summary parts before persistence', () => {
      const parts = [
        { type: ContentTypes.SUMMARY },
        { type: ContentTypes.SUMMARY, content: [] },
        { type: ContentTypes.SUMMARY, content: [{ type: ContentTypes.TEXT, text: '   ' }] },
        { type: ContentTypes.SUMMARY, text: '\n\t' },
        { type: ContentTypes.TEXT, text: 'Final answer' },
      ] as TMessageContentParts[];

      expect(filterMalformedContentParts(parts)).toEqual([
        { type: ContentTypes.TEXT, text: 'Final answer' },
      ]);
    });

    it('keeps current and legacy summary parts that contain text', () => {
      const current = {
        type: ContentTypes.SUMMARY,
        content: [{ type: ContentTypes.TEXT, text: 'Current summary' }],
      };
      const legacyContent = {
        type: ContentTypes.SUMMARY,
        content: 'Legacy content summary',
      };
      const legacyText = {
        type: ContentTypes.SUMMARY,
        text: 'Legacy text summary',
      };

      expect(filterMalformedContentParts([current, legacyContent, legacyText])).toEqual([
        current,
        legacyContent,
        legacyText,
      ]);
    });

    it('should filter out null or undefined parts', () => {
      const parts = [
        { type: ContentTypes.TEXT, text: 'Valid' },
        null,
        undefined,
        { type: ContentTypes.TEXT, text: 'Also valid' },
      ] as TMessageContentParts[];

      const result = filterMalformedContentParts(parts);
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('text', 'Valid');
      expect(result[1]).toHaveProperty('text', 'Also valid');
    });

    it('should return non-array input unchanged', () => {
      const notAnArray = { some: 'object' };
      const result = filterMalformedContentParts(notAnArray);
      expect(result).toBe(notAnArray);
    });
  });

  describe('real-life example with multiple tool calls', () => {
    it('should filter out malformed tool_call entries from actual MCP response', () => {
      const parts: TMessageContentParts[] = [
        {
          type: ContentTypes.THINK,
          think:
            'The user is asking for 10 different time zones, similar to what would be displayed in a stock trading room floor.',
        },
        {
          type: ContentTypes.TEXT,
          text: '# Global Market Times\n\nShowing current time in 10 major financial centers:',
          tool_call_ids: ['tooluse_Yjfib8PoRXCeCcHRH0JqCw'],
        },
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'tooluse_Yjfib8PoRXCeCcHRH0JqCw',
            name: 'get_current_time_mcp_time',
            args: '{"timezone":"America/New_York"}',
            type: ToolCallTypes.TOOL_CALL,
            progress: 1,
            output: '{"timezone":"America/New_York","datetime":"2025-11-13T13:43:17-05:00"}',
          },
        },
        { type: ContentTypes.TOOL_CALL } as TMessageContentParts,
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'tooluse_CPsGv9kXTrewVkcO7BEYIg',
            name: 'get_current_time_mcp_time',
            args: '{"timezone":"Europe/London"}',
            type: ToolCallTypes.TOOL_CALL,
            progress: 1,
            output: '{"timezone":"Europe/London","datetime":"2025-11-13T18:43:19+00:00"}',
          },
        },
        { type: ContentTypes.TOOL_CALL } as TMessageContentParts,
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'tooluse_5jihRbd4TDWCGebwmAUlfQ',
            name: 'get_current_time_mcp_time',
            args: '{"timezone":"Asia/Tokyo"}',
            type: ToolCallTypes.TOOL_CALL,
            progress: 1,
            output: '{"timezone":"Asia/Tokyo","datetime":"2025-11-14T03:43:21+09:00"}',
          },
        },
        { type: ContentTypes.TOOL_CALL } as TMessageContentParts,
        { type: ContentTypes.TOOL_CALL } as TMessageContentParts,
        { type: ContentTypes.TOOL_CALL } as TMessageContentParts,
        {
          type: ContentTypes.TEXT,
          text: '## Major Financial Markets Clock:\n\n| Market | Local Time | Day |',
        },
      ];

      const result = filterMalformedContentParts(parts);

      expect(result).toHaveLength(6);

      expect(result[0].type).toBe(ContentTypes.THINK);
      expect(result[1].type).toBe(ContentTypes.TEXT);
      expect(result[2].type).toBe(ContentTypes.TOOL_CALL);
      expect(result[3].type).toBe(ContentTypes.TOOL_CALL);
      expect(result[4].type).toBe(ContentTypes.TOOL_CALL);
      expect(result[5].type).toBe(ContentTypes.TEXT);

      const toolCalls = result.filter((part) => part.type === ContentTypes.TOOL_CALL);
      expect(toolCalls).toHaveLength(3);

      toolCalls.forEach((toolCall) => {
        if (toolCall.type === ContentTypes.TOOL_CALL) {
          expect(toolCall.tool_call).toBeDefined();
          expect(toolCall.tool_call).toHaveProperty('id');
          expect(toolCall.tool_call).toHaveProperty('name');
        }
      });
    });

    it('should handle empty array', () => {
      const result = filterMalformedContentParts([]);
      expect(result).toEqual([]);
    });

    it('should handle array with only malformed tool calls', () => {
      const parts = [
        { type: ContentTypes.TOOL_CALL },
        { type: ContentTypes.TOOL_CALL },
        { type: ContentTypes.TOOL_CALL },
      ] as TMessageContentParts[];

      const result = filterMalformedContentParts(parts);
      expect(result).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should filter out tool_call with null tool_call property', () => {
      const parts = [
        { type: ContentTypes.TOOL_CALL, tool_call: null as unknown as ToolCall },
      ] as TMessageContentParts[];

      const result = filterMalformedContentParts(parts);
      expect(result).toHaveLength(0);
    });

    it('should filter out tool_call with non-object tool_call property', () => {
      const parts = [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: 'not an object' as unknown as ToolCall & PartMetadata,
        },
      ] as TMessageContentParts[];

      const result = filterMalformedContentParts(parts);
      expect(result).toHaveLength(0);
    });

    it('should keep tool_call with empty object as tool_call', () => {
      const parts: TMessageContentParts[] = [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {} as unknown as Agents.ToolCall & PartMetadata,
        },
      ];

      const result = filterMalformedContentParts(parts);
      expect(result).toHaveLength(1);
    });
  });

  describe('parent activity phase bounds', () => {
    const toolPart = (id: string): TMessageContentParts => ({
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id,
        name: 'fetch_fact',
        type: ToolCallTypes.TOOL_CALL,
        args: '{}',
        progress: 1,
        output: 'result',
      },
    });
    const childLabel = (label: string): TMessageContentParts =>
      ({ type: ContentTypes.ACTIVITY_LABEL, activity_label: label }) as TMessageContentParts;
    const phaseMarker = (start: number, end: number): TMessageContentParts =>
      ({
        type: ContentTypes.ACTIVITY_LABEL,
        activity_label: 'Gathered both facts',
        activity_label_type: 'phase',
        activity_start_index: start,
        activity_end_index: end,
        activity_count: 2,
      }) as TMessageContentParts;
    const phaseOf = (parts: TMessageContentParts[]) =>
      parts.find(
        (part) =>
          part.type === ContentTypes.ACTIVITY_LABEL &&
          (part as { activity_label_type?: string }).activity_label_type === 'phase',
      ) as { activity_start_index?: number; activity_end_index?: number } | undefined;

    /** A model turn that emits no text before its tool calls leaves the source
     *  slot empty, so the aggregator's array arrives here sparse. */
    const sparseRun = (): TMessageContentParts[] => {
      const parts: TMessageContentParts[] = [];
      parts[1] = toolPart('call_alpha');
      parts[2] = childLabel('Looked up alpha');
      parts[4] = toolPart('call_beta');
      parts[5] = childLabel('Looked up beta');
      parts[6] = { type: ContentTypes.TEXT, text: 'Final answer' };
      parts[7] = phaseMarker(0, 6);
      parts.length = 8;
      return parts;
    };

    it('rebases bounds onto compacted coordinates when holes are removed', () => {
      const result = filterMalformedContentParts(sparseRun());

      expect(result).toHaveLength(6);
      const finalTextIndex = result.findIndex(
        (part) => part.type === ContentTypes.TEXT && part.text === 'Final answer',
      );
      expect(finalTextIndex).toBe(4);
      /** The exclusive end must still land on the final answer so the parent
       *  card groups the two activities and nothing more. */
      expect(phaseOf(result)?.activity_end_index).toBe(finalTextIndex);
      expect(phaseOf(result)?.activity_start_index).toBe(0);
    });

    it('keeps the grouped children exactly the tool and label parts', () => {
      const result = filterMalformedContentParts(sparseRun());
      const phase = phaseOf(result);
      const children = result.slice(phase?.activity_start_index ?? 0, phase?.activity_end_index);

      expect(children).toHaveLength(4);
      expect(
        children
          .map((part) => (part.type === ContentTypes.TOOL_CALL ? part.tool_call?.id : undefined))
          .filter(Boolean),
      ).toEqual(['call_alpha', 'call_beta']);
      expect(children.some((part) => part.type === ContentTypes.TEXT)).toBe(false);
    });

    it('leaves the source array in its own coordinate space', () => {
      const parts = sparseRun();
      filterMalformedContentParts(parts);

      expect(phaseOf(parts.filter(Boolean) as TMessageContentParts[])?.activity_end_index).toBe(6);
    });

    it('rebases past a dropped malformed tool_call', () => {
      const parts: TMessageContentParts[] = [
        toolPart('call_alpha'),
        { type: ContentTypes.TOOL_CALL } as TMessageContentParts,
        { type: ContentTypes.TEXT, text: 'Final answer' },
        phaseMarker(0, 2),
      ];

      const result = filterMalformedContentParts(parts);

      expect(result).toHaveLength(3);
      expect(phaseOf(result)?.activity_end_index).toBe(1);
      expect(result[1]).toMatchObject({ type: ContentTypes.TEXT, text: 'Final answer' });
    });

    it('maps a bound that lands on a dropped slot to the next retained part', () => {
      const parts: TMessageContentParts[] = [];
      parts[0] = toolPart('call_alpha');
      parts[2] = { type: ContentTypes.TEXT, text: 'Final answer' };
      parts[3] = phaseMarker(1, 2);
      parts.length = 4;

      const result = filterMalformedContentParts(parts);

      expect(phaseOf(result)?.activity_start_index).toBe(1);
      expect(phaseOf(result)?.activity_end_index).toBe(1);
    });

    it('leaves bounds and part identity untouched when nothing is dropped', () => {
      const parts: TMessageContentParts[] = [
        toolPart('call_alpha'),
        { type: ContentTypes.TEXT, text: 'Final answer' },
        phaseMarker(0, 1),
      ];

      const result = filterMalformedContentParts(parts);

      expect(result[2]).toBe(parts[2]);
      expect(phaseOf(result)?.activity_start_index).toBe(0);
      expect(phaseOf(result)?.activity_end_index).toBe(1);
    });

    it('does not touch per-batch activity labels', () => {
      const parts: TMessageContentParts[] = [];
      parts[1] = toolPart('call_alpha');
      parts[2] = childLabel('Looked up alpha');
      parts.length = 3;

      const result = filterMalformedContentParts(parts);

      expect(result).toHaveLength(2);
      expect(result[1]).toBe(parts[2]);
    });
  });
});
