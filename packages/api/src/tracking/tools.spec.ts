import { Tools, serverProductFactSchema } from 'librechat-data-provider';
import type { ServerProductFact } from 'librechat-data-provider';
import { getProductToolIdentity, getProductBuiltinToolIdentity } from './tools';
import { createProductToolObserver } from '~/agents/product';

describe('product tool identity', () => {
  it('keeps only allowlisted names from resolved built-in tools', () => {
    expect(getProductToolIdentity({ name: Tools.web_search })).toEqual({
      toolCategory: 'builtin',
      toolName: Tools.web_search,
    });
    expect(getProductBuiltinToolIdentity('check_background_task')).toEqual({
      toolCategory: 'builtin',
      toolName: 'check_background_task',
    });
    expect(getProductBuiltinToolIdentity('web_search_private@example.test')).toEqual({
      toolCategory: 'custom',
    });
  });

  it.each([
    [{ name: 'query_mcp_private@example.test', mcp: true }, 'mcp'],
    [{ name: Tools.web_search, mcp: true }, 'mcp'],
    [{ name: 'lookup_action_private@example.test' }, 'action'],
    [{ name: 'private@example.test' }, 'custom'],
    [undefined, 'custom'],
  ] as const)('classifies a resolved tool without exporting its name', (tool, category) => {
    expect(getProductToolIdentity(tool)).toEqual({ toolCategory: category });
  });

  it.each(['foreground', 'background', 'programmatic'] as const)(
    'keeps identifiers but excludes custom names and payloads in %s execution',
    async (mode) => {
      const productTracker = jest.fn<void, [ServerProductFact]>();
      const name = 'lookup_private@example.test';
      const observe = createProductToolObserver(
        { productTracking: { enabled: true }, productTracker },
        () => getProductToolIdentity({ name, mcp: true }),
      );
      const identity = {
        toolName: name,
        toolCallId: 'call',
        parentToolCallId: 'parent-call',
        runId: 'run',
        parentRunId: 'parent-run',
        mode,
      };
      const result = { content: 'private tool result' };
      expect(await observe(identity, async () => result)).toBe(result);
      expect(productTracker).toHaveBeenCalledTimes(2);
      for (const [fact] of productTracker.mock.calls) {
        expect(serverProductFactSchema.safeParse(fact).success).toBe(true);
        expect(fact).toMatchObject({
          toolCategory: 'mcp',
          toolCallId: 'call',
          parentToolCallId: 'parent-call',
          runId: 'run',
          parentRunId: 'parent-run',
          mode,
        });
        expect(fact).not.toHaveProperty('toolName');
      }
      const failure = new Error('private provider failure');
      await expect(
        observe(identity, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(productTracker.mock.calls[3][0]).toMatchObject({ outcome: 'failed' });
      expect(JSON.stringify(productTracker.mock.calls)).not.toContain('private');
    },
  );

  it('executes normally when tool classification is unavailable', async () => {
    const productTracker = jest.fn();
    const observe = createProductToolObserver(
      { productTracking: { enabled: true }, productTracker },
      () => {
        throw new Error('private metadata');
      },
    );
    expect(
      await observe(
        { toolName: 'private@example.test', toolCallId: 'call', mode: 'foreground' },
        async () => 'result',
      ),
    ).toBe('result');
    expect(productTracker.mock.calls[0][0]).toMatchObject({ toolCategory: 'custom' });
    expect(JSON.stringify(productTracker.mock.calls)).not.toContain('private');
  });
});
