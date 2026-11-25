import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { renderHook, act } from '@testing-library/react';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TEphemeralAgent, TStartupConfig, TModelSpec } from 'librechat-data-provider';
import { useApplyModelSpecEffects, useApplyAgentTemplate } from '../useApplyModelSpecAgents';
import { ephemeralAgentByConvoId, useUpdateEphemeralAgent } from '~/store/agents';

const NEW_CONVO = Constants.NEW_CONVO as string;

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <RecoilRoot>{children}</RecoilRoot>
);

const createModelSpec = (name: string): TModelSpec =>
  ({
    name,
    label: name,
    preset: {
      endpoint: EModelEndpoint.openAI,
      model: name,
    },
  }) as TModelSpec;

const createStartupConfig = (list: TModelSpec[]): TStartupConfig =>
  ({
    modelSpecs: {
      list,
      prioritize: false,
    },
  }) as TStartupConfig;

const specsConfig = () => createStartupConfig([createModelSpec('test-spec')]);

const useHarness = (conversationId: string) => {
  const applyModelSpecEffects = useApplyModelSpecEffects();
  const updateEphemeralAgent = useUpdateEphemeralAgent();
  const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(conversationId));
  return { applyModelSpecEffects, updateEphemeralAgent, ephemeralAgent };
};

describe('useApplyModelSpecEffects', () => {
  it('preserves an existing conversation ephemeral agent on an in-place model switch', () => {
    const conversationId = 'convo-123';
    const agent: TEphemeralAgent = { mcp: ['clickhouse'] };
    const { result } = renderHook(() => useHarness(conversationId), { wrapper: Wrapper });

    act(() => {
      result.current.updateEphemeralAgent(conversationId, agent);
    });
    expect(result.current.ephemeralAgent).toEqual(agent);

    act(() => {
      result.current.applyModelSpecEffects({
        convoId: conversationId,
        specName: null,
        prevConvoId: conversationId,
        prevSpecName: null,
        startupConfig: specsConfig(),
      });
    });

    expect(result.current.ephemeralAgent).toEqual(agent);
  });

  it('preserves a new conversation ephemeral agent on an in-place model switch', () => {
    const agent: TEphemeralAgent = { mcp: ['clickhouse'] };
    const { result } = renderHook(() => useHarness(NEW_CONVO), { wrapper: Wrapper });

    act(() => {
      result.current.updateEphemeralAgent(NEW_CONVO, agent);
    });

    act(() => {
      result.current.applyModelSpecEffects({
        convoId: NEW_CONVO,
        specName: null,
        prevConvoId: NEW_CONVO,
        prevSpecName: null,
        startupConfig: specsConfig(),
      });
    });

    expect(result.current.ephemeralAgent).toEqual(agent);
  });

  it('resets the ephemeral agent when switching away from a spec', () => {
    const { result } = renderHook(() => useHarness(NEW_CONVO), { wrapper: Wrapper });

    act(() => {
      result.current.updateEphemeralAgent(NEW_CONVO, { mcp: ['clickhouse'] });
    });

    act(() => {
      result.current.applyModelSpecEffects({
        convoId: NEW_CONVO,
        specName: null,
        prevConvoId: NEW_CONVO,
        prevSpecName: 'test-spec',
        startupConfig: specsConfig(),
      });
    });

    expect(result.current.ephemeralAgent).toBeNull();
  });

  it('resets the new conversation ephemeral agent when leaving an existing conversation', () => {
    const { result } = renderHook(() => useHarness(NEW_CONVO), { wrapper: Wrapper });

    act(() => {
      result.current.updateEphemeralAgent(NEW_CONVO, { mcp: ['clickhouse'] });
    });

    act(() => {
      result.current.applyModelSpecEffects({
        convoId: NEW_CONVO,
        specName: null,
        prevConvoId: 'convo-123',
        prevSpecName: null,
        startupConfig: specsConfig(),
      });
    });

    expect(result.current.ephemeralAgent).toBeNull();
  });

  it('leaves the ephemeral agent untouched when no specs are configured', () => {
    const agent: TEphemeralAgent = { mcp: ['clickhouse'] };
    const { result } = renderHook(() => useHarness(NEW_CONVO), { wrapper: Wrapper });

    act(() => {
      result.current.updateEphemeralAgent(NEW_CONVO, agent);
    });

    act(() => {
      result.current.applyModelSpecEffects({
        convoId: NEW_CONVO,
        specName: null,
        prevConvoId: 'convo-123',
        prevSpecName: 'test-spec',
        startupConfig: {} as TStartupConfig,
      });
    });

    expect(result.current.ephemeralAgent).toEqual(agent);
  });
});

const useTemplateHarness = (targetId: string) => {
  const applyAgentTemplate = useApplyAgentTemplate();
  const ephemeralAgent = useRecoilValue(ephemeralAgentByConvoId(targetId));
  return { applyAgentTemplate, ephemeralAgent };
};

describe('useApplyAgentTemplate spec merge (#15277)', () => {
  const targetId = 'convo-saved';

  const specWithTools = (overrides: Partial<TModelSpec>): TStartupConfig =>
    createStartupConfig([{ ...createModelSpec('test-spec'), ...overrides } as TModelSpec]);

  it('does not re-add an MCP server the user deselected before submitting', () => {
    const { result } = renderHook(() => useTemplateHarness(targetId), { wrapper: Wrapper });

    act(() => {
      result.current.applyAgentTemplate({
        targetId,
        sourceId: NEW_CONVO,
        ephemeralAgent: { mcp: [] },
        specName: 'test-spec',
        startupConfig: specWithTools({ mcpServers: ['clickhouse'] }),
      });
    });

    expect(result.current.ephemeralAgent?.mcp).toEqual([]);
  });

  it('keeps the submitted selection rather than unioning it with the spec list', () => {
    const { result } = renderHook(() => useTemplateHarness(targetId), { wrapper: Wrapper });

    act(() => {
      result.current.applyAgentTemplate({
        targetId,
        sourceId: NEW_CONVO,
        ephemeralAgent: { mcp: ['github'] },
        specName: 'test-spec',
        startupConfig: specWithTools({ mcpServers: ['clickhouse'] }),
      });
    });

    expect(result.current.ephemeralAgent?.mcp).toEqual(['github']);
  });

  it('applies the spec MCP list when the submission carries no selection', () => {
    const { result } = renderHook(() => useTemplateHarness(targetId), { wrapper: Wrapper });

    act(() => {
      result.current.applyAgentTemplate({
        targetId,
        sourceId: NEW_CONVO,
        ephemeralAgent: {},
        specName: 'test-spec',
        startupConfig: specWithTools({ mcpServers: ['clickhouse'] }),
      });
    });

    expect(result.current.ephemeralAgent?.mcp).toEqual(['clickhouse']);
  });

  it("re-pins a hidden spec's capabilities rather than trusting what was submitted", () => {
    const { result } = renderHook(() => useTemplateHarness(targetId), { wrapper: Wrapper });

    act(() => {
      result.current.applyAgentTemplate({
        targetId,
        sourceId: NEW_CONVO,
        ephemeralAgent: { web_search: false, mcp: [], memory: false },
        specName: 'test-spec',
        startupConfig: specWithTools({
          hideBadgeRow: true,
          webSearch: true,
          mcpServers: ['clickhouse'],
        }),
      });
    });

    expect(result.current.ephemeralAgent?.web_search).toBe(true);
    expect(result.current.ephemeralAgent?.mcp).toEqual(['clickhouse']);
    /** The spec is silent on memory, so the submitted value still stands. */
    expect(result.current.ephemeralAgent?.memory).toBe(false);
  });

  it('carries an explicit tool opt-out through the merge', () => {
    const { result } = renderHook(() => useTemplateHarness(targetId), { wrapper: Wrapper });

    act(() => {
      result.current.applyAgentTemplate({
        targetId,
        sourceId: NEW_CONVO,
        ephemeralAgent: { web_search: false, skills: false },
        specName: 'test-spec',
        startupConfig: specWithTools({ webSearch: true, skills: true }),
      });
    });

    expect(result.current.ephemeralAgent?.web_search).toBe(false);
    expect(result.current.ephemeralAgent?.skills).toBe(false);
  });
});
