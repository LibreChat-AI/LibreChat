import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { act, render, waitFor } from '@testing-library/react';
import { Constants, LocalStorageKeys, mcpServerToggleKey } from 'librechat-data-provider';
import type { TEphemeralAgent } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { MCPServerDefinition } from '~/hooks/MCP/useMCPServerManager';
import { useApplyAgentToolSwitches } from '../useApplyAgentToolSwitches';
import { cleanupTimestampedStorage } from '~/utils/timestamps';
import { useMCPSelect } from '~/hooks/MCP/useMCPSelect';
import { ephemeralAgentByConvoId } from '~/store';

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetStartupConfig: jest.fn(() => ({ data: undefined })),
}));

const serverName = 'mock-elicitation';
const servers = [
  { serverName, config: { type: 'sse', url: 'http://localhost' }, effectivePermissions: 1 },
] as unknown as MCPServerDefinition[];

type SavedAgent = Pick<Agent, 'id' | 'tools' | 'tool_options'>;

const withToggle = (toggle?: 'on' | 'off'): SavedAgent => ({
  id: 'agent_1',
  tools: [`echo_mcp_${serverName}`],
  tool_options: toggle ? { [mcpServerToggleKey(serverName)]: { user_toggle: toggle } } : {},
});

let selected: string[] = [];
let select: (value: string[]) => void = () => undefined;

function Picker({ conversationId }: { conversationId: string | null }) {
  const { mcpValues, setMCPValues } = useMCPSelect({
    conversationId,
    servers,
    ownsChatSelection: true,
  });
  selected = mcpValues;
  select = setMCPValues;
  return null;
}

function Chat({
  agent,
  conversationId = null,
}: {
  agent: SavedAgent;
  conversationId?: string | null;
}) {
  useApplyAgentToolSwitches({ agent, conversationId });
  return <Picker conversationId={conversationId} />;
}

describe('useApplyAgentToolSwitches', () => {
  beforeEach(() => {
    localStorage.clear();
    selected = [];
  });

  it('selects a default-on MCP server in a new chat', async () => {
    render(
      <RecoilRoot>
        <Provider store={createStore()}>
          <Chat agent={withToggle('on')} />
        </Provider>
      </RecoilRoot>,
    );
    await waitFor(() => expect(selected).toEqual([serverName]));
  });

  it.each([
    ['not switchable', undefined],
    ['switchable, starts off', 'off' as const],
  ])(
    'selects a default-on MCP server once the saved agent changes from %s',
    async (_label, previousToggle) => {
      const store = createStore();
      const tree = (agent: SavedAgent) => (
        <RecoilRoot>
          <Provider store={store}>
            <Chat agent={agent} />
          </Provider>
        </RecoilRoot>
      );
      const { rerender } = render(tree(withToggle(previousToggle)));
      await waitFor(() => expect(selected).toEqual([]));

      rerender(tree(withToggle('on')));
      await waitFor(() => expect(selected).toEqual([serverName]));
    },
  );

  describe('switching agents inside one new chat', () => {
    const agentX: SavedAgent = {
      id: 'agent_x',
      tools: ['web_search', 'echo_mcp_x-server'],
      tool_options: {
        web_search: { user_toggle: 'on' },
        [mcpServerToggleKey('x-server')]: { user_toggle: 'on' },
      },
    };
    let ephemeralAgent: TEphemeralAgent | null = null;
    let store = createStore();
    beforeEach(() => {
      ephemeralAgent = null;
      store = createStore();
    });
    function Probe({ agent }: { agent: SavedAgent }) {
      useApplyAgentToolSwitches({ agent, conversationId: null });
      ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(Constants.NEW_CONVO));
      return null;
    }
    const tree = (agent: SavedAgent) => (
      <RecoilRoot>
        <Provider store={store}>
          <Probe agent={agent} />
        </Provider>
      </RecoilRoot>
    );

    it("shows the next agent's defaults and clears the previous agent's switches", async () => {
      const { rerender } = render(tree(agentX));
      await waitFor(() => expect(ephemeralAgent).toEqual({ web_search: true, mcp: ['x-server'] }));

      rerender(
        tree({
          id: 'agent_y',
          tools: ['execute_code'],
          tool_options: { execute_code: { user_toggle: 'off' } },
        }),
      );
      await waitFor(() => expect(ephemeralAgent).toEqual({ execute_code: false, mcp: [] }));
    });

    it("clears the previous agent's switches when the next agent has none", async () => {
      const { rerender } = render(tree(agentX));
      await waitFor(() => expect(ephemeralAgent).toEqual({ web_search: true, mcp: ['x-server'] }));

      rerender(tree({ id: 'agent_z', tools: ['web_search'], tool_options: {} }));
      await waitFor(() => expect(ephemeralAgent).toEqual({ mcp: [] }));
    });
  });

  it('keeps a default-on server the user turned off once the new chat gets its real id', async () => {
    const store = createStore();
    let applyTemplate: (agent: TEphemeralAgent) => void = () => undefined;
    function TemplateWriter() {
      applyTemplate = useSetRecoilState(ephemeralAgentByConvoId('real1'));
      return null;
    }
    const tree = (conversationId: string | null) => (
      <RecoilRoot>
        <Provider store={store}>
          <TemplateWriter />
          <Chat agent={withToggle('on')} conversationId={conversationId} />
        </Provider>
      </RecoilRoot>
    );
    const { rerender } = render(tree(null));
    await waitFor(() => expect(selected).toEqual([serverName]));

    act(() => select([]));
    await waitFor(() => expect(selected).toEqual([]));

    /** What the SSE handlers do on the first response: copy the submitted state to the real id. */
    act(() => {
      applyTemplate({ mcp: [] });
      rerender(tree('real1'));
    });
    await waitFor(() =>
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_MCP_}real1`)).not.toBeNull(),
    );
    expect(selected).toEqual([]);
    expect(
      JSON.parse(localStorage.getItem(`${LocalStorageKeys.LAST_MCP_}real1`) ?? 'null'),
    ).toEqual([]);
  });

  it('keeps a default-on server the user turned off after the app reloads', async () => {
    let applyTemplate: (agent: TEphemeralAgent) => void = () => undefined;
    function TemplateWriter() {
      applyTemplate = useSetRecoilState(ephemeralAgentByConvoId('real1'));
      return null;
    }
    const store = createStore();
    const tree = (conversationId: string | null) => (
      <RecoilRoot>
        <Provider store={store}>
          <TemplateWriter />
          <Chat agent={withToggle('on')} conversationId={conversationId} />
        </Provider>
      </RecoilRoot>
    );
    const { rerender, unmount } = render(tree(null));
    await waitFor(() => expect(selected).toEqual([serverName]));

    act(() => select([]));
    await waitFor(() => expect(selected).toEqual([]));

    act(() => {
      applyTemplate({ mcp: [] });
      rerender(tree('real1'));
    });
    await waitFor(() =>
      expect(localStorage.getItem(`${LocalStorageKeys.LAST_MCP_}real1`)).not.toBeNull(),
    );
    unmount();

    /** App startup prunes conversation keys without a timestamp. */
    cleanupTimestampedStorage();
    render(
      <RecoilRoot>
        <Provider store={createStore()}>
          <Chat agent={withToggle('on')} conversationId="real1" />
        </Provider>
      </RecoilRoot>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(selected).toEqual([]);
  });

  it('keeps a default-on server turned off in an existing chat after a reload near the cleanup age', async () => {
    const hour = 60 * 60 * 1000;
    const storageKey = `${LocalStorageKeys.LAST_MCP_}c1`;
    const tree = () => (
      <RecoilRoot>
        <Provider store={createStore()}>
          <Chat agent={withToggle('on')} conversationId="c1" />
        </Provider>
      </RecoilRoot>
    );
    const { unmount } = render(tree());
    await waitFor(() => expect(selected).toEqual([serverName]));

    /** The last non-empty selection was stamped 47 hours ago. */
    localStorage.setItem(`${storageKey}_TIMESTAMP`, String(Date.now() - 47 * hour));
    act(() => select([]));
    await waitFor(() => expect(selected).toEqual([]));
    unmount();

    /** Reload three hours later: startup cleanup runs before the chat mounts. */
    const now = Date.now() + 3 * hour;
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      cleanupTimestampedStorage();
    } finally {
      dateNow.mockRestore();
    }
    expect(JSON.parse(localStorage.getItem(storageKey) ?? 'null')).toEqual([]);

    render(tree());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(selected).toEqual([]);
  });
});
