import { formatAgentMessages } from '@librechat/agents';
import { Constants, ContentTypes } from 'librechat-data-provider';
import { AIMessage, ToolMessage } from '@librechat/agents/langchain/messages';
import type { TPayload } from '@librechat/agents';
import { buildRunToolSet } from './tools';

describe('agent tool history formatting', () => {
  it('preserves handoff and destination-agent calls as structured pairs', () => {
    const primary = {
      edges: [{ from: 'primary', to: 'researcher', edgeType: 'handoff' as const }],
      toolDefinitions: [{ name: 'primary_tool' }],
    };
    const researcher = {
      toolDefinitions: [{ name: 'research_database' }],
    };
    const transferName = `${Constants.LC_TRANSFER_TO_}researcher`;
    const payload: TPayload = [
      { role: 'user', content: 'Research this topic' },
      {
        role: 'assistant',
        content: [
          {
            type: ContentTypes.TEXT,
            text: 'I delegated the research.',
            tool_call_ids: ['transfer-1', 'research-1'],
          },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'transfer-1',
              name: transferName,
              args: '{}',
              output: '',
            },
          },
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'research-1',
              name: 'research_database',
              args: '{}',
              output: '{"result":"verified"}',
            },
          },
        ],
      },
    ];

    const toolSet = buildRunToolSet(primary, [researcher]);
    const { messages } = formatAgentMessages(payload, undefined, toolSet);
    const assistant = messages[1] as AIMessage;
    const toolMessages = messages.filter(
      (message) => message instanceof ToolMessage,
    ) as ToolMessage[];

    expect(assistant.tool_calls?.map(({ name }) => name)).toEqual([
      transferName,
      'research_database',
    ]);
    expect(JSON.stringify(assistant.content)).not.toContain('Tool:');
    expect(toolMessages.map(({ name }) => name)).toEqual([transferName, 'research_database']);
  });

  it('preserves an authorized MCP wildcard call without a live catalog', () => {
    const primary = {
      historicalToolNames: [`${Constants.mcp_all}${Constants.mcp_delimiter}warehouse`],
    };
    const payload: TPayload = [
      { role: 'user', content: 'Run the saved query' },
      {
        role: 'assistant',
        content: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'subagent-1',
              name: `${Constants.SUBAGENT}`,
              args: '{}',
              output: 'Finished the query',
              subagent_content: [
                {
                  type: ContentTypes.TOOL_CALL,
                  tool_call: {
                    id: 'query-1',
                    name: 'run_query_mcp_warehouse',
                    args: '{}',
                    output: '{"rows":1}',
                  },
                },
              ],
            },
          },
        ],
      },
    ];

    const toolSet = buildRunToolSet(primary, null, null, payload);
    const { messages } = formatAgentMessages(payload, undefined, toolSet);

    expect(toolSet).toContain('run_query_mcp_warehouse');
    expect(JSON.stringify(messages)).not.toContain('Tool:');
    expect(messages.some((message) => message instanceof ToolMessage)).toBe(true);
  });
});
