import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { renderHook, act } from '@testing-library/react';
import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TEphemeralAgent, TStartupConfig, TModelSpec } from 'librechat-data-provider';
import { ephemeralAgentByConvoId, useUpdateEphemeralAgent } from '~/store/agents';
import { useApplyModelSpecEffects } from '../useApplyModelSpecAgents';

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
