import { useMemo } from 'react';
import { AgentCapabilities } from 'librechat-data-provider';

interface AgentCapabilitiesResult {
  toolsEnabled: boolean;
  actionsEnabled: boolean;
  artifactsEnabled: boolean;
  ocrEnabled: boolean;
  contextEnabled: boolean;
  fileSearchEnabled: boolean;
  webSearchEnabled: boolean;
  codeEnabled: boolean;
  skillsEnabled: boolean;
  memoryEnabled: boolean;
  deferredToolsEnabled: boolean;
  programmaticToolsEnabled: boolean;
  backgroundToolsEnabled: boolean;
  toolIntentsEnabled: boolean;
}

export default function useAgentCapabilities(
  capabilities: AgentCapabilities[] | undefined,
): AgentCapabilitiesResult {
  const toolsEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.tools) ?? false,
    [capabilities],
  );

  const actionsEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.actions) ?? false,
    [capabilities],
  );

  const artifactsEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.artifacts) ?? false,
    [capabilities],
  );

  const ocrEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.ocr) ?? false,
    [capabilities],
  );

  const contextEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.context) ?? false,
    [capabilities],
  );

  const fileSearchEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.file_search) ?? false,
    [capabilities],
  );

  const webSearchEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.web_search) ?? false,
    [capabilities],
  );

  const codeEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.execute_code) ?? false,
    [capabilities],
  );

  const skillsEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.skills) ?? false,
    [capabilities],
  );

  const memoryEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.memory) ?? false,
    [capabilities],
  );

  const deferredToolsEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.deferred_tools) ?? false,
    [capabilities],
  );

  const programmaticToolsEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.programmatic_tools) ?? false,
    [capabilities],
  );

  const backgroundToolsEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.run_in_background) ?? false,
    [capabilities],
  );

  const toolIntentsEnabled = useMemo(
    () => capabilities?.includes(AgentCapabilities.tool_intents) ?? false,
    [capabilities],
  );

  return {
    ocrEnabled,
    codeEnabled,
    toolsEnabled,
    skillsEnabled,
    memoryEnabled,
    actionsEnabled,
    contextEnabled,
    artifactsEnabled,
    webSearchEnabled,
    fileSearchEnabled,
    deferredToolsEnabled,
    programmaticToolsEnabled,
    backgroundToolsEnabled,
    toolIntentsEnabled,
  };
}
