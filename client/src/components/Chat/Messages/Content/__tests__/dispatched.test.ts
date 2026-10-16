import { Tools, ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { getStandardToolCall } from '../live';
import { getToolMeta } from '../outcome';

const dispatcherPart = (toolCall: Record<string, unknown>) =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id: 'call_1',
      name: 'call_tool',
      args: '{"name":"web_search","arguments":"{\\"query\\":\\"news\\"}"}',
      ...toolCall,
    },
  }) as unknown as TMessageContentParts;

describe('dispatcher calls in tool headers', () => {
  it('names a completed call after the tool it ran', () => {
    const part = dispatcherPart({
      output: 'done',
      progress: 1,
      dispatched: { name: Tools.web_search, args: '{"query":"news"}' },
    });
    expect(getStandardToolCall(part)).toMatchObject({
      name: Tools.web_search,
      args: '{"query":"news"}',
    });
    expect(getToolMeta(part)).toMatchObject({ name: Tools.web_search, hasOutput: true });
  });

  it('names a streaming call after its target once the arguments parse', () => {
    expect(getStandardToolCall(dispatcherPart({}))?.name).toBe(Tools.web_search);
    expect(getStandardToolCall(dispatcherPart({ args: '{"name":"web' }))?.name).toBe('call_tool');
  });
});
