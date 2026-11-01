import { renderHook, act } from '@testing-library/react';
import { useFormContext, useWatch } from 'react-hook-form';
import type { AgentToolType } from 'librechat-data-provider';
import useMCPToolOptions from '../useMCPToolOptions';

jest.mock('react-hook-form', () => ({
  useFormContext: jest.fn(),
  useWatch: jest.fn(),
}));

const mockSetValue = jest.fn();
const mockGetValues = jest.fn();

const createMockTool = (toolId: string): AgentToolType => ({
  tool_id: toolId,
  metadata: { name: toolId, description: `Description for ${toolId}` },
});

describe('useMCPToolOptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useFormContext as jest.Mock).mockReturnValue({
      getValues: mockGetValues,
      setValue: mockSetValue,
      control: {},
    });
    (useWatch as jest.Mock).mockReturnValue(undefined);
    mockGetValues.mockReturnValue({});
  });

  describe('isToolDeferred', () => {
    it('should return false when tool_options is undefined', () => {
      (useWatch as jest.Mock).mockReturnValue(undefined);

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolDeferred('tool1')).toBe(false);
    });

    it('should return false when tool has no options', () => {
      (useWatch as jest.Mock).mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolDeferred('tool1')).toBe(false);
    });

    it('should return false when defer_loading is not set', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { allowed_callers: ['direct'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolDeferred('tool1')).toBe(false);
    });

    it('should return true when defer_loading is true', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolDeferred('tool1')).toBe(true);
    });

    it('should return false when defer_loading is false', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: false },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolDeferred('tool1')).toBe(false);
    });
  });

  describe('isToolProgrammatic', () => {
    it('should return false when tool_options is undefined', () => {
      (useWatch as jest.Mock).mockReturnValue(undefined);

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolProgrammatic('tool1')).toBe(false);
    });

    it('should return false when tool has no options', () => {
      (useWatch as jest.Mock).mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolProgrammatic('tool1')).toBe(false);
    });

    it('should return false when allowed_callers does not include code_execution', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { allowed_callers: ['direct'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolProgrammatic('tool1')).toBe(false);
    });

    it('should return true when allowed_callers includes code_execution', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { allowed_callers: ['code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolProgrammatic('tool1')).toBe(true);
    });

    it('should return true when allowed_callers includes both direct and code_execution', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { allowed_callers: ['direct', 'code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolProgrammatic('tool1')).toBe(true);
    });
  });

  describe('toggleToolDefer', () => {
    it('should enable defer_loading for a tool with no existing options', () => {
      mockGetValues.mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolDefer('tool1');
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool1: { defer_loading: true } },
        { shouldDirty: true },
      );
    });

    it('should enable defer_loading while preserving other options', () => {
      mockGetValues.mockReturnValue({
        tool1: { allowed_callers: ['code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolDefer('tool1');
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool1: { allowed_callers: ['code_execution'], defer_loading: true } },
        { shouldDirty: true },
      );
    });

    it('should disable defer_loading and preserve other options', () => {
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: true, allowed_callers: ['code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolDefer('tool1');
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool1: { allowed_callers: ['code_execution'] } },
        { shouldDirty: true },
      );
    });

    it('should remove tool entry entirely when disabling defer_loading and no other options exist', () => {
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolDefer('tool1');
      });

      expect(mockSetValue).toHaveBeenCalledWith('tool_options', {}, { shouldDirty: true });
    });

    it('should preserve other tools when toggling', () => {
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: true },
        tool2: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolDefer('tool1');
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool2: { defer_loading: true } },
        { shouldDirty: true },
      );
    });
  });

  describe('toggleToolProgrammatic', () => {
    it('should enable programmatic calling for a tool with no existing options', () => {
      mockGetValues.mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolProgrammatic('tool1');
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool1: { allowed_callers: ['code_execution'] } },
        { shouldDirty: true },
      );
    });

    it('should enable programmatic calling while preserving defer_loading', () => {
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolProgrammatic('tool1');
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool1: { defer_loading: true, allowed_callers: ['code_execution'] } },
        { shouldDirty: true },
      );
    });

    it('should disable programmatic calling and preserve defer_loading', () => {
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: true, allowed_callers: ['code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolProgrammatic('tool1');
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool1: { defer_loading: true } },
        { shouldDirty: true },
      );
    });

    it('should remove tool entry entirely when disabling programmatic and no other options exist', () => {
      mockGetValues.mockReturnValue({
        tool1: { allowed_callers: ['code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolProgrammatic('tool1');
      });

      expect(mockSetValue).toHaveBeenCalledWith('tool_options', {}, { shouldDirty: true });
    });

    it('should preserve other tools when toggling', () => {
      mockGetValues.mockReturnValue({
        tool1: { allowed_callers: ['code_execution'] },
        tool2: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolProgrammatic('tool1');
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool2: { defer_loading: true } },
        { shouldDirty: true },
      );
    });
  });

  describe('areAllToolsDeferred', () => {
    it('should return false for empty tools array', () => {
      (useWatch as jest.Mock).mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.areAllToolsDeferred([])).toBe(false);
    });

    it('should return false when no tools are deferred', () => {
      (useWatch as jest.Mock).mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      expect(result.current.areAllToolsDeferred(tools)).toBe(false);
    });

    it('should return false when some tools are deferred', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      expect(result.current.areAllToolsDeferred(tools)).toBe(false);
    });

    it('should return true when all tools are deferred', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: true },
        tool2: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      expect(result.current.areAllToolsDeferred(tools)).toBe(true);
    });
  });

  describe('areAllToolsProgrammatic', () => {
    it('should return false for empty tools array', () => {
      (useWatch as jest.Mock).mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.areAllToolsProgrammatic([])).toBe(false);
    });

    it('should return false when no tools are programmatic', () => {
      (useWatch as jest.Mock).mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      expect(result.current.areAllToolsProgrammatic(tools)).toBe(false);
    });

    it('should return false when some tools are programmatic', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { allowed_callers: ['code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      expect(result.current.areAllToolsProgrammatic(tools)).toBe(false);
    });

    it('should return true when all tools are programmatic', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { allowed_callers: ['code_execution'] },
        tool2: { allowed_callers: ['code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      expect(result.current.areAllToolsProgrammatic(tools)).toBe(true);
    });
  });

  describe('toggleDeferAll', () => {
    it('should do nothing for empty tools array', () => {
      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleDeferAll([]);
      });

      expect(mockSetValue).not.toHaveBeenCalled();
    });

    it('should defer all tools when none are deferred', () => {
      (useWatch as jest.Mock).mockReturnValue({});
      mockGetValues.mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleDeferAll(tools);
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        {
          tool1: { defer_loading: true },
          tool2: { defer_loading: true },
        },
        { shouldDirty: true },
      );
    });

    it('should undefer all tools when all are deferred', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: true },
        tool2: { defer_loading: true },
      });
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: true },
        tool2: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleDeferAll(tools);
      });

      expect(mockSetValue).toHaveBeenCalledWith('tool_options', {}, { shouldDirty: true });
    });

    it('should defer all when some are deferred (brings to consistent state)', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: true },
      });
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleDeferAll(tools);
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        {
          tool1: { defer_loading: true },
          tool2: { defer_loading: true },
        },
        { shouldDirty: true },
      );
    });

    it('should preserve other options when deferring', () => {
      (useWatch as jest.Mock).mockReturnValue({});
      mockGetValues.mockReturnValue({
        tool1: { allowed_callers: ['code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleDeferAll(tools);
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        {
          tool1: { allowed_callers: ['code_execution'], defer_loading: true },
          tool2: { defer_loading: true },
        },
        { shouldDirty: true },
      );
    });

    it('should preserve other options when undeferring', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: true, allowed_callers: ['code_execution'] },
        tool2: { defer_loading: true },
      });
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: true, allowed_callers: ['code_execution'] },
        tool2: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleDeferAll(tools);
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool1: { allowed_callers: ['code_execution'] } },
        { shouldDirty: true },
      );
    });
  });

  describe('toggleProgrammaticAll', () => {
    it('should do nothing for empty tools array', () => {
      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleProgrammaticAll([]);
      });

      expect(mockSetValue).not.toHaveBeenCalled();
    });

    it('should make all tools programmatic when none are', () => {
      (useWatch as jest.Mock).mockReturnValue({});
      mockGetValues.mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleProgrammaticAll(tools);
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        {
          tool1: { allowed_callers: ['code_execution'] },
          tool2: { allowed_callers: ['code_execution'] },
        },
        { shouldDirty: true },
      );
    });

    it('should remove programmatic from all tools when all are programmatic', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { allowed_callers: ['code_execution'] },
        tool2: { allowed_callers: ['code_execution'] },
      });
      mockGetValues.mockReturnValue({
        tool1: { allowed_callers: ['code_execution'] },
        tool2: { allowed_callers: ['code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleProgrammaticAll(tools);
      });

      expect(mockSetValue).toHaveBeenCalledWith('tool_options', {}, { shouldDirty: true });
    });

    it('should make all programmatic when some are (brings to consistent state)', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { allowed_callers: ['code_execution'] },
      });
      mockGetValues.mockReturnValue({
        tool1: { allowed_callers: ['code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleProgrammaticAll(tools);
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        {
          tool1: { allowed_callers: ['code_execution'] },
          tool2: { allowed_callers: ['code_execution'] },
        },
        { shouldDirty: true },
      );
    });

    it('should preserve defer_loading when making programmatic', () => {
      (useWatch as jest.Mock).mockReturnValue({});
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleProgrammaticAll(tools);
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        {
          tool1: { defer_loading: true, allowed_callers: ['code_execution'] },
          tool2: { allowed_callers: ['code_execution'] },
        },
        { shouldDirty: true },
      );
    });

    it('should preserve defer_loading when removing programmatic', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: true, allowed_callers: ['code_execution'] },
        tool2: { allowed_callers: ['code_execution'] },
      });
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: true, allowed_callers: ['code_execution'] },
        tool2: { allowed_callers: ['code_execution'] },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleProgrammaticAll(tools);
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool1: { defer_loading: true } },
        { shouldDirty: true },
      );
    });
  });

  describe('intent (describe_intent)', () => {
    it('reads the flag only when explicitly true', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { describe_intent: true },
        tool2: { run_in_background: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolIntent('tool1')).toBe(true);
      expect(result.current.isToolIntent('tool2')).toBe(false);
    });

    it('toggling on writes describe_intent without clobbering sibling flags', () => {
      mockGetValues.mockReturnValue({ tool1: { run_in_background: true } });

      const { result } = renderHook(() => useMCPToolOptions());
      act(() => result.current.toggleToolIntent('tool1'));

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool1: { run_in_background: true, describe_intent: true } },
        { shouldDirty: true },
      );
    });

    it('toggling off removes the flag and drops an empty entry', () => {
      mockGetValues.mockReturnValue({ tool1: { describe_intent: true } });
      (useWatch as jest.Mock).mockReturnValue({ tool1: { describe_intent: true } });

      const { result } = renderHook(() => useMCPToolOptions());
      act(() => result.current.toggleToolIntent('tool1'));

      expect(mockSetValue).toHaveBeenCalledWith('tool_options', {}, { shouldDirty: true });
    });

    it('bulk toggle marks every tool and unmarks when all are set', () => {
      const tools = [createMockTool('tool1'), createMockTool('tool2')];
      mockGetValues.mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());
      act(() => result.current.toggleIntentAll(tools));

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool1: { describe_intent: true }, tool2: { describe_intent: true } },
        { shouldDirty: true },
      );
    });
  });

  describe('isToolProgrammaticOnly', () => {
    it('mirrors the backend canInjectIntentParam gate exactly', () => {
      (useWatch as jest.Mock).mockReturnValue({
        codeOnly: { allowed_callers: ['code_execution'] },
        both: { allowed_callers: ['direct', 'code_execution'] },
        directOnly: { allowed_callers: ['direct'] },
        empty: { allowed_callers: [] },
        unset: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolProgrammaticOnly('codeOnly')).toBe(true);
      expect(result.current.isToolProgrammaticOnly('both')).toBe(false);
      expect(result.current.isToolProgrammaticOnly('directOnly')).toBe(false);
      expect(result.current.isToolProgrammaticOnly('empty')).toBe(false);
      expect(result.current.isToolProgrammaticOnly('unset')).toBe(false);
      expect(result.current.isToolProgrammaticOnly('missing')).toBe(false);
    });
  });

  describe('server-level deferLoading (three-state)', () => {
    it('isToolDeferred inherits the server default when there is no explicit option', () => {
      (useWatch as jest.Mock).mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolDeferred('tool1', true)).toBe(true);
      expect(result.current.isToolDeferred('tool1', false)).toBe(false);
    });

    it('isToolDeferred lets an explicit false override an inherited true', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: false },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolDeferred('tool1', true)).toBe(false);
    });

    it('isToolDeferred lets an explicit true override an inherited false', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: true },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.isToolDeferred('tool1', false)).toBe(true);
    });

    it('toggleToolDefer writes an explicit false when turning off an inherited-true tool', () => {
      mockGetValues.mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolDefer('tool1', true);
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        { tool1: { defer_loading: false } },
        { shouldDirty: true },
      );
    });

    it('toggleToolDefer deletes the explicit key when toggling back to match the server default', () => {
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: false },
      });

      const { result } = renderHook(() => useMCPToolOptions());

      act(() => {
        result.current.toggleToolDefer('tool1', true);
      });

      expect(mockSetValue).toHaveBeenCalledWith('tool_options', {}, { shouldDirty: true });
    });

    it('areAllToolsDeferred honors inheritance from the server default', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: false },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      expect(result.current.areAllToolsDeferred(tools, true)).toBe(false);
    });

    it('areAllToolsDeferred returns true when every tool inherits a true server default', () => {
      (useWatch as jest.Mock).mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      expect(result.current.areAllToolsDeferred(tools, true)).toBe(true);
    });

    it('toggleDeferAll collapses to explicit false then back to the server default', () => {
      (useWatch as jest.Mock).mockReturnValue({});
      mockGetValues.mockReturnValue({});

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleDeferAll(tools, true);
      });

      expect(mockSetValue).toHaveBeenCalledWith(
        'tool_options',
        {
          tool1: { defer_loading: false },
          tool2: { defer_loading: false },
        },
        { shouldDirty: true },
      );
    });

    it('toggleDeferAll deletes explicit keys when bringing tools back to a true server default', () => {
      (useWatch as jest.Mock).mockReturnValue({
        tool1: { defer_loading: false },
        tool2: { defer_loading: false },
      });
      mockGetValues.mockReturnValue({
        tool1: { defer_loading: false },
        tool2: { defer_loading: false },
      });

      const { result } = renderHook(() => useMCPToolOptions());
      const tools = [createMockTool('tool1'), createMockTool('tool2')];

      act(() => {
        result.current.toggleDeferAll(tools, true);
      });

      expect(mockSetValue).toHaveBeenCalledWith('tool_options', {}, { shouldDirty: true });
    });
  });

  describe('formToolOptions', () => {
    it('should return undefined when useWatch returns undefined', () => {
      (useWatch as jest.Mock).mockReturnValue(undefined);

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.formToolOptions).toBeUndefined();
    });

    it('should return the tool options from useWatch', () => {
      const toolOptions = {
        tool1: { defer_loading: true },
        tool2: { allowed_callers: ['code_execution'] },
      };
      (useWatch as jest.Mock).mockReturnValue(toolOptions);

      const { result } = renderHook(() => useMCPToolOptions());

      expect(result.current.formToolOptions).toEqual(toolOptions);
    });
  });
});
