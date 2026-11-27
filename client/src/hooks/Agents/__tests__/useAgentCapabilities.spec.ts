import { renderHook } from '@testing-library/react';
import { AgentCapabilities } from 'librechat-data-provider';
import useAgentCapabilities from '../useAgentCapabilities';

describe('useAgentCapabilities', () => {
  it('should return all capabilities as false when capabilities is undefined', () => {
    const { result } = renderHook(() => useAgentCapabilities(undefined));

    expect(result.current.toolsEnabled).toBe(false);
    expect(result.current.actionsEnabled).toBe(false);
    expect(result.current.artifactsEnabled).toBe(false);
    expect(result.current.ocrEnabled).toBe(false);
    expect(result.current.contextEnabled).toBe(false);
    expect(result.current.fileSearchEnabled).toBe(false);
    expect(result.current.webSearchEnabled).toBe(false);
    expect(result.current.codeEnabled).toBe(false);
    expect(result.current.deferredToolsEnabled).toBe(false);
    expect(result.current.programmaticToolsEnabled).toBe(false);
  });

  it('should return all capabilities as false when capabilities is empty array', () => {
    const { result } = renderHook(() => useAgentCapabilities([]));

    expect(result.current.toolsEnabled).toBe(false);
    expect(result.current.deferredToolsEnabled).toBe(false);
    expect(result.current.programmaticToolsEnabled).toBe(false);
  });

  it('should return true for enabled capabilities', () => {
    const capabilities = [
      AgentCapabilities.tools,
      AgentCapabilities.deferred_tools,
      AgentCapabilities.file_search,
    ];

    const { result } = renderHook(() => useAgentCapabilities(capabilities));

    expect(result.current.toolsEnabled).toBe(true);
    expect(result.current.deferredToolsEnabled).toBe(true);
    expect(result.current.fileSearchEnabled).toBe(true);
    expect(result.current.actionsEnabled).toBe(false);
    expect(result.current.webSearchEnabled).toBe(false);
  });

  it('should return deferredToolsEnabled as true when deferred_tools is in capabilities', () => {
    const capabilities = [AgentCapabilities.deferred_tools];

    const { result } = renderHook(() => useAgentCapabilities(capabilities));

    expect(result.current.deferredToolsEnabled).toBe(true);
  });

  it('should return deferredToolsEnabled as false when deferred_tools is not in capabilities', () => {
    const capabilities = [
      AgentCapabilities.tools,
      AgentCapabilities.actions,
      AgentCapabilities.artifacts,
    ];

    const { result } = renderHook(() => useAgentCapabilities(capabilities));

    expect(result.current.deferredToolsEnabled).toBe(false);
  });

  it('should return programmaticToolsEnabled as true when programmatic_tools is in capabilities', () => {
    const capabilities = [AgentCapabilities.programmatic_tools];

    const { result } = renderHook(() => useAgentCapabilities(capabilities));

    expect(result.current.programmaticToolsEnabled).toBe(true);
  });

  it('should return programmaticToolsEnabled as false when programmatic_tools is not in capabilities', () => {
    const capabilities = [
      AgentCapabilities.tools,
      AgentCapabilities.actions,
      AgentCapabilities.artifacts,
    ];

    const { result } = renderHook(() => useAgentCapabilities(capabilities));

    expect(result.current.programmaticToolsEnabled).toBe(false);
  });

  it('should handle all capabilities being enabled', () => {
    const capabilities = [
      AgentCapabilities.tools,
      AgentCapabilities.actions,
      AgentCapabilities.artifacts,
      AgentCapabilities.ocr,
      AgentCapabilities.context,
      AgentCapabilities.file_search,
      AgentCapabilities.web_search,
      AgentCapabilities.execute_code,
      AgentCapabilities.deferred_tools,
      AgentCapabilities.programmatic_tools,
    ];

    const { result } = renderHook(() => useAgentCapabilities(capabilities));

    expect(result.current.toolsEnabled).toBe(true);
    expect(result.current.actionsEnabled).toBe(true);
    expect(result.current.artifactsEnabled).toBe(true);
    expect(result.current.ocrEnabled).toBe(true);
    expect(result.current.contextEnabled).toBe(true);
    expect(result.current.fileSearchEnabled).toBe(true);
    expect(result.current.webSearchEnabled).toBe(true);
    expect(result.current.codeEnabled).toBe(true);
    expect(result.current.deferredToolsEnabled).toBe(true);
    expect(result.current.programmaticToolsEnabled).toBe(true);
  });

  it('should return toolIntentsEnabled as true when tool_intents is in capabilities', () => {
    const { result } = renderHook(() => useAgentCapabilities([AgentCapabilities.tool_intents]));

    expect(result.current.toolIntentsEnabled).toBe(true);
    expect(result.current.backgroundToolsEnabled).toBe(false);
  });

  it('should return toolIntentsEnabled as false when absent', () => {
    const { result } = renderHook(() => useAgentCapabilities([]));

    expect(result.current.toolIntentsEnabled).toBe(false);
  });
});
