import { TOOL_DISPATCHER_NAME as sdkName } from '@librechat/agents';
import { TOOL_DISPATCHER_NAME as clientName } from 'librechat-data-provider';

describe('dispatcher tool name', () => {
  it('is the same for the client that renders dispatched calls and for the SDK', () => {
    expect(clientName).toBe(sdkName);
  });
});
