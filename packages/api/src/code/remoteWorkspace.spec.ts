import { validateResponseRequest } from '../agents/responses/service';
import { createMCPRuntimeRequestBody } from '../mcp/request';
import { validateRequest } from '../agents/openai/service';

const selections = [{ environmentId: 'machine', workspaceId: 'project' }];
describe('remote workspace selection envelopes', () => {
  it('rejects workspace extensions on chat completions, which cannot persist the decision', () => {
    expect(
      validateRequest({
        model: 'agent',
        messages: [{ role: 'user', content: 'hello' }],
        code_workspaces: selections,
      }).valid,
    ).toBe(false);
  });

  it('validates responses selection identity without accepting duplicate environments', () => {
    expect(
      validateResponseRequest({ model: 'agent', input: 'hello', code_workspaces: selections })
        .valid,
    ).toBe(true);
    expect(
      validateResponseRequest({
        model: 'agent',
        input: 'hello',
        code_workspaces: [...selections, ...selections],
      }).valid,
    ).toBe(false);
    expect(
      validateResponseRequest({
        model: 'agent',
        input: 'hello',
        code_workspaces: [{ ...selections[0], path: '/secret' }],
      }).valid,
    ).toBe(false);
  });
  it('carries selections into the runtime envelope', () => {
    expect(
      createMCPRuntimeRequestBody({
        messageId: 'm',
        conversationId: 'c',
        codeWorkspaces: selections,
      }),
    ).toEqual({ messageId: 'm', conversationId: 'c', codeWorkspaces: selections });
  });
});
