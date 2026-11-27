import { renderHook } from '@testing-library/react';
import { Tools, EToolResources } from 'librechat-data-provider';
import useAgentToolPermissions from '../useAgentToolPermissions';

// Mock the dependencies
jest.mock('~/data-provider', () => ({
  useGetAgentByIdQuery: jest.fn(),
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: jest.fn(),
}));

const mockUseGetAgentByIdQuery = jest.requireMock('~/data-provider').useGetAgentByIdQuery;
const mockUseAgentsMapContext = jest.requireMock('~/Providers').useAgentsMapContext;

describe('useAgentToolPermissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('when no agentId is provided', () => {
    it('should disallow all tools for ephemeral agents when no ephemeralAgent settings provided', () => {
      mockUseAgentsMapContext.mockReturnValue({});
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const { result } = renderHook(() => useAgentToolPermissions(null));

      expect(result.current.fileSearchAllowedByAgent).toBe(false);
      expect(result.current.codeAllowedByAgent).toBe(false);
      expect(result.current.tools).toBeUndefined();
    });

    it('should disallow all tools when agentId is undefined and no ephemeralAgent settings', () => {
      mockUseAgentsMapContext.mockReturnValue({});
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const { result } = renderHook(() => useAgentToolPermissions(undefined));

      expect(result.current.fileSearchAllowedByAgent).toBe(false);
      expect(result.current.codeAllowedByAgent).toBe(false);
      expect(result.current.tools).toBeUndefined();
    });

    it('should disallow all tools when agentId is empty string and no ephemeralAgent settings', () => {
      mockUseAgentsMapContext.mockReturnValue({});
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const { result } = renderHook(() => useAgentToolPermissions(''));

      expect(result.current.fileSearchAllowedByAgent).toBe(false);
      expect(result.current.codeAllowedByAgent).toBe(false);
      expect(result.current.tools).toBeUndefined();
    });
  });

  describe('when agentId is provided but agent not found', () => {
    it('should disallow all tools', () => {
      mockUseAgentsMapContext.mockReturnValue({});
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const { result } = renderHook(() => useAgentToolPermissions('agent_nonexistent'));

      expect(result.current.fileSearchAllowedByAgent).toBe(false);
      expect(result.current.codeAllowedByAgent).toBe(false);
      expect(result.current.tools).toBeUndefined();
    });
  });

  describe('when agent is found with tools', () => {
    it('should allow tools that are included in the agent tools array', () => {
      const agentId = 'agent_test';
      const agent = {
        id: agentId,
        tools: [Tools.file_search],
      };

      mockUseAgentsMapContext.mockReturnValue({ [agentId]: agent });
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const { result } = renderHook(() => useAgentToolPermissions(agentId));

      expect(result.current.fileSearchAllowedByAgent).toBe(true);
      expect(result.current.codeAllowedByAgent).toBe(false);
      expect(result.current.tools).toEqual([Tools.file_search]);
    });

    it('should allow both tools when both are included', () => {
      const agentId = 'agent_test';
      const agent = {
        id: agentId,
        tools: [Tools.file_search, Tools.execute_code],
      };

      mockUseAgentsMapContext.mockReturnValue({ [agentId]: agent });
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const { result } = renderHook(() => useAgentToolPermissions(agentId));

      expect(result.current.fileSearchAllowedByAgent).toBe(true);
      expect(result.current.codeAllowedByAgent).toBe(true);
      expect(result.current.tools).toEqual([Tools.file_search, Tools.execute_code]);
    });

    it('should use data from API query when available', () => {
      const agentId = 'agent_test';
      const agentMapData = {
        id: agentId,
        tools: [Tools.file_search],
      };
      const agentApiData = {
        id: agentId,
        tools: [Tools.execute_code, Tools.file_search],
      };

      mockUseAgentsMapContext.mockReturnValue({ [agentId]: agentMapData });
      mockUseGetAgentByIdQuery.mockReturnValue({ data: agentApiData });

      const { result } = renderHook(() => useAgentToolPermissions(agentId));

      // API data should take precedence
      expect(result.current.fileSearchAllowedByAgent).toBe(true);
      expect(result.current.codeAllowedByAgent).toBe(true);
      expect(result.current.tools).toEqual([Tools.execute_code, Tools.file_search]);
    });

    it('should use the hydrated code environment when available', () => {
      const agentId = 'agent_test';
      mockUseAgentsMapContext.mockReturnValue({
        [agentId]: {
          id: agentId,
          tools: [Tools.execute_code],
          code_environment_id: 'stale',
          stateful_code_sessions: false,
        },
      });
      mockUseGetAgentByIdQuery.mockReturnValue({
        data: {
          id: agentId,
          tools: [Tools.execute_code],
          code_environment_id: 'attached-vm',
          stateful_code_sessions: true,
        },
      });

      const { result } = renderHook(() => useAgentToolPermissions(agentId));

      expect(result.current.codeEnvironmentId).toBe('attached-vm');
      expect(result.current.statefulCodeSessionsAllowedByAgent).toBe(true);
    });

    it('preserves execution graph metadata omitted by the basic agent response', () => {
      const agentId = 'agent_test';
      mockUseAgentsMapContext.mockReturnValue({
        [agentId]: {
          id: agentId,
          tools: [Tools.execute_code],
          code_environment_id: 'attached-vm',
          code_workspace_id: 'project-a',
          stateful_code_sessions: true,
          agent_ids: ['agent-child'],
        },
      });
      mockUseGetAgentByIdQuery.mockReturnValue({
        data: { id: agentId, name: 'Safe agent response' },
      });

      const { result } = renderHook(() => useAgentToolPermissions(agentId));

      expect(result.current.agent).toMatchObject({
        id: agentId,
        name: 'Safe agent response',
        code_environment_id: 'attached-vm',
        code_workspace_id: 'project-a',
        agent_ids: ['agent-child'],
      });
    });

    it('should fallback to agent map data when API data is not available', () => {
      const agentId = 'agent_test';
      const agentMapData = {
        id: agentId,
        tools: [Tools.execute_code],
      };

      mockUseAgentsMapContext.mockReturnValue({ [agentId]: agentMapData });
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const { result } = renderHook(() => useAgentToolPermissions(agentId));

      expect(result.current.fileSearchAllowedByAgent).toBe(false);
      expect(result.current.codeAllowedByAgent).toBe(true);
      expect(result.current.tools).toEqual([Tools.execute_code]);
    });
  });

  describe('when agent has no tools', () => {
    it('should disallow all tools with empty array', () => {
      const agentId = 'agent_test';
      const agent = {
        id: agentId,
        tools: [],
      };

      mockUseAgentsMapContext.mockReturnValue({ [agentId]: agent });
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const { result } = renderHook(() => useAgentToolPermissions(agentId));

      expect(result.current.fileSearchAllowedByAgent).toBe(false);
      expect(result.current.codeAllowedByAgent).toBe(false);
      expect(result.current.tools).toEqual([]);
    });

    it('should disallow all tools with undefined tools', () => {
      const agentId = 'agent_test';
      const agent = {
        id: agentId,
        tools: undefined,
      };

      mockUseAgentsMapContext.mockReturnValue({ [agentId]: agent });
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const { result } = renderHook(() => useAgentToolPermissions(agentId));

      expect(result.current.fileSearchAllowedByAgent).toBe(false);
      expect(result.current.codeAllowedByAgent).toBe(false);
      expect(result.current.tools).toBeUndefined();
    });
  });

  describe('when ephemeralAgent settings are provided', () => {
    it('should allow file_search when ephemeralAgent has file_search enabled', () => {
      mockUseAgentsMapContext.mockReturnValue({});
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const ephemeralAgent = {
        [EToolResources.file_search]: true,
      };

      const { result } = renderHook(() => useAgentToolPermissions(null, ephemeralAgent));

      expect(result.current.fileSearchAllowedByAgent).toBe(true);
      expect(result.current.codeAllowedByAgent).toBe(false);
      expect(result.current.tools).toBeUndefined();
    });

    it('should allow execute_code when ephemeralAgent has execute_code enabled', () => {
      mockUseAgentsMapContext.mockReturnValue({});
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const ephemeralAgent = {
        [EToolResources.execute_code]: true,
      };

      const { result } = renderHook(() => useAgentToolPermissions(undefined, ephemeralAgent));

      expect(result.current.fileSearchAllowedByAgent).toBe(false);
      expect(result.current.codeAllowedByAgent).toBe(true);
      expect(result.current.tools).toBeUndefined();
    });

    it('should allow both tools when ephemeralAgent has both enabled', () => {
      mockUseAgentsMapContext.mockReturnValue({});
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const ephemeralAgent = {
        [EToolResources.file_search]: true,
        [EToolResources.execute_code]: true,
      };

      const { result } = renderHook(() => useAgentToolPermissions('', ephemeralAgent));

      expect(result.current.fileSearchAllowedByAgent).toBe(true);
      expect(result.current.codeAllowedByAgent).toBe(true);
      expect(result.current.tools).toBeUndefined();
    });

    it('should not affect regular agents when ephemeralAgent is provided', () => {
      const agentId = 'agent_regular';
      const agent = {
        id: agentId,
        tools: [Tools.file_search],
      };

      mockUseAgentsMapContext.mockReturnValue({ [agentId]: agent });
      mockUseGetAgentByIdQuery.mockReturnValue({ data: undefined });

      const ephemeralAgent = {
        [EToolResources.execute_code]: true,
      };

      const { result } = renderHook(() => useAgentToolPermissions(agentId, ephemeralAgent));

      // Should use regular agent's tools, not ephemeralAgent
      expect(result.current.fileSearchAllowedByAgent).toBe(true);
      expect(result.current.codeAllowedByAgent).toBe(false);
      expect(result.current.tools).toEqual([Tools.file_search]);
    });
  });
});
