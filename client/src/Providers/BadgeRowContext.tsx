import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { useSetRecoilState } from 'recoil';
import { Tools, Constants, LocalStorageKeys, AgentCapabilities } from 'librechat-data-provider';
import type { TAgentsEndpoint, TEphemeralAgent } from 'librechat-data-provider';
import {
  useMCPServerManager,
  useSearchApiKeyForm,
  useGetAgentsConfig,
  useToolToggle,
} from '~/hooks';
import { getTimestampedValue } from '~/utils/timestamps';
import { useGetStartupConfig } from '~/data-provider';
import { ephemeralAgentByConvoId } from '~/store';

interface BadgeRowContextType {
  conversationId?: string | null;
  storageContextKey?: string;
  agentsConfig?: TAgentsEndpoint | null;
  skills: ReturnType<typeof useToolToggle>;
  memory: ReturnType<typeof useToolToggle>;
  webSearch: ReturnType<typeof useToolToggle>;
  artifacts: ReturnType<typeof useToolToggle>;
  fileSearch: ReturnType<typeof useToolToggle>;
  codeInterpreter: ReturnType<typeof useToolToggle>;
  searchApiKeyForm: ReturnType<typeof useSearchApiKeyForm>;
  mcpServerManager: ReturnType<typeof useMCPServerManager>;
}

const BadgeRowContext = createContext<BadgeRowContextType | undefined>(undefined);

export function useBadgeRowContext() {
  return useContext(BadgeRowContext);
}

interface BadgeRowProviderProps {
  children: React.ReactNode;
  isSubmitting?: boolean;
  conversationId?: string | null;
  specName?: string | null;
  observeToolAuthorization?: boolean;
}

export default function BadgeRowProvider({
  children,
  isSubmitting,
  conversationId,
  specName,
  observeToolAuthorization = false,
}: BadgeRowProviderProps) {
  const lastContextKeyRef = useRef<string>('');
  const hasInitializedRef = useRef(false);
  const { agentsConfig } = useGetAgentsConfig();
  const { data: startupConfig } = useGetStartupConfig();
  const key = conversationId ?? Constants.NEW_CONVO;
  const hasModelSpecs = (startupConfig?.modelSpecs?.list?.length ?? 0) > 0;

  /**
   * Compute the storage context key for non-spec persistence:
   * - `__defaults__`: specs configured but none active → shared defaults key
   * - undefined: spec active (no persistence) or no specs configured (original behavior)
   *
   * When a spec is active, tool/MCP state is NOT persisted — the admin's spec
   * configuration is always applied fresh. Only non-spec user preferences persist.
   */
  const storageContextKey = useMemo(() => {
    if (!specName && hasModelSpecs) {
      return Constants.spec_defaults_key as string;
    }
    return undefined;
  }, [specName, hasModelSpecs]);

  /**
   * Compute the storage suffix for reading localStorage defaults:
   * - New conversations read from environment key (spec or non-spec defaults)
   * - Existing conversations read from conversation key (per-conversation state)
   */
  const isNewConvo = key === Constants.NEW_CONVO;
  const storageSuffix = isNewConvo && storageContextKey ? storageContextKey : key;

  const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(key));

  /** Initialize ephemeralAgent from localStorage on mount and when conversation/spec changes.
   *  Skipped when a spec is active — applyModelSpecEphemeralAgent handles both new conversations
   *  (pure spec values) and existing conversations (spec values + localStorage overrides). */
  useEffect(() => {
    if (isSubmitting) {
      return;
    }
    if (specName) {
      // Spec active: applyModelSpecEphemeralAgent handles all state (spec base + localStorage
      // overrides for existing conversations). Reset init flag so switching back to non-spec
      // triggers a fresh re-init.
      hasInitializedRef.current = false;
      return;
    }
    // Check if this is a new conversation/spec or the first load
    if (!hasInitializedRef.current || lastContextKeyRef.current !== storageSuffix) {
      hasInitializedRef.current = true;
      lastContextKeyRef.current = storageSuffix;

      const codeToggleKey = `${LocalStorageKeys.LAST_CODE_TOGGLE_}${storageSuffix}`;
      const webSearchToggleKey = `${LocalStorageKeys.LAST_WEB_SEARCH_TOGGLE_}${storageSuffix}`;
      const fileSearchToggleKey = `${LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_}${storageSuffix}`;
      const artifactsToggleKey = `${LocalStorageKeys.LAST_ARTIFACTS_TOGGLE_}${storageSuffix}`;
      const skillsToggleKey = `${LocalStorageKeys.LAST_SKILLS_TOGGLE_}${storageSuffix}`;
      const memoryToggleKey = `${LocalStorageKeys.LAST_MEMORY_TOGGLE_}${storageSuffix}`;

      const codeToggleValue = getTimestampedValue(codeToggleKey);
      const webSearchToggleValue = getTimestampedValue(webSearchToggleKey);
      const fileSearchToggleValue = getTimestampedValue(fileSearchToggleKey);
      const artifactsToggleValue = getTimestampedValue(artifactsToggleKey);
      const skillsToggleValue = getTimestampedValue(skillsToggleKey);
      const memoryToggleValue = getTimestampedValue(memoryToggleKey);

      const initialValues: Record<string, boolean | string> = {};

      if (codeToggleValue !== null) {
        try {
          initialValues[Tools.execute_code] = JSON.parse(codeToggleValue);
        } catch (e) {
          console.error('Failed to parse code toggle value:', e);
        }
      }

      if (webSearchToggleValue !== null) {
        try {
          initialValues[Tools.web_search] = JSON.parse(webSearchToggleValue);
        } catch (e) {
          console.error('Failed to parse web search toggle value:', e);
        }
      }

      if (fileSearchToggleValue !== null) {
        try {
          initialValues[Tools.file_search] = JSON.parse(fileSearchToggleValue);
        } catch (e) {
          console.error('Failed to parse file search toggle value:', e);
        }
      }

      if (artifactsToggleValue !== null) {
        try {
          initialValues[AgentCapabilities.artifacts] = JSON.parse(artifactsToggleValue);
        } catch (e) {
          console.error('Failed to parse artifacts toggle value:', e);
        }
      }

      if (skillsToggleValue !== null) {
        try {
          initialValues[AgentCapabilities.skills] = JSON.parse(skillsToggleValue);
        } catch (e) {
          console.error('Failed to parse skills toggle value:', e);
        }
      }

      if (memoryToggleValue !== null) {
        try {
          initialValues[Tools.memory] = JSON.parse(memoryToggleValue);
        } catch (e) {
          console.error('Failed to parse memory toggle value:', e);
        }
      }

      const hasOverrides = Object.keys(initialValues).length > 0;

      /** Read persisted MCP values from localStorage */
      let mcpOverrides: string[] | null = null;
      const mcpStorageKey = `${LocalStorageKeys.LAST_MCP_}${storageSuffix}`;
      const mcpRaw = localStorage.getItem(mcpStorageKey);
      if (mcpRaw !== null) {
        try {
          const parsed = JSON.parse(mcpRaw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            mcpOverrides = parsed;
          }
        } catch (e) {
          console.error('Failed to parse MCP values:', e);
        }
      }

      setEphemeralAgent((prev) => {
        if (prev == null) {
          /** ephemeralAgent is null — use localStorage defaults */
          if (hasOverrides || mcpOverrides) {
            const result: TEphemeralAgent = { ...initialValues };
            if (mcpOverrides) {
              result.mcp = mcpOverrides;
            }
            return result;
          }
          return prev;
        }
        /** ephemeralAgent already has values (from prior state).
         *  Only fill in undefined keys from localStorage. */
        let changed = false;
        const result = { ...prev };
        for (const [toolKey, value] of Object.entries(initialValues)) {
          if (result[toolKey] === undefined) {
            result[toolKey] = value;
            changed = true;
          }
        }
        if (mcpOverrides && result.mcp === undefined) {
          result.mcp = mcpOverrides;
          changed = true;
        }
        return changed ? result : prev;
      });
    }
  }, [storageSuffix, specName, isSubmitting, setEphemeralAgent]);

  /** CodeInterpreter hook — sandbox auth is handled server-side by the
   *  agents library, so the toggle no longer has an auth dialog gate. */
  const codeInterpreter = useToolToggle({
    conversationId,
    storageContextKey,
    toolKey: Tools.execute_code,
    localStorageKey: LocalStorageKeys.LAST_CODE_TOGGLE_,
    isAuthenticated: true,
  });

  /** WebSearch hooks */
  const searchApiKeyForm = useSearchApiKeyForm({});
  const { setIsDialogOpen: setWebSearchDialogOpen } = searchApiKeyForm;

  const webSearch = useToolToggle({
    conversationId,
    storageContextKey,
    toolKey: Tools.web_search,
    localStorageKey: LocalStorageKeys.LAST_WEB_SEARCH_TOGGLE_,
    setIsDialogOpen: setWebSearchDialogOpen,
    authConfig: {
      toolId: Tools.web_search,
      queryOptions: { retry: 1 },
    },
  });

  /** FileSearch hook */
  const fileSearch = useToolToggle({
    conversationId,
    storageContextKey,
    toolKey: Tools.file_search,
    localStorageKey: LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_,
    isAuthenticated: true,
  });

  /** Artifacts hook - using a custom key since it's not a Tool but a capability */
  const artifacts = useToolToggle({
    conversationId,
    storageContextKey,
    toolKey: AgentCapabilities.artifacts,
    localStorageKey: LocalStorageKeys.LAST_ARTIFACTS_TOGGLE_,
    isAuthenticated: true,
  });

  /** Skills hook - using a custom key since it's not a Tool but a capability */
  const skills = useToolToggle({
    conversationId,
    storageContextKey,
    toolKey: AgentCapabilities.skills,
    localStorageKey: LocalStorageKeys.LAST_SKILLS_TOGGLE_,
    isAuthenticated: true,
  });

  /** Memory hook - per-conversation toggle for the inline memory tools */
  const memory = useToolToggle({
    conversationId,
    storageContextKey,
    toolKey: Tools.memory,
    localStorageKey: LocalStorageKeys.LAST_MEMORY_TOGGLE_,
    isAuthenticated: true,
  });

  const mcpServerManager = useMCPServerManager({
    conversationId,
    storageContextKey,
    specName,
    ownsChatSelection: true,
    observeToolAuthorization,
  });

  const value: BadgeRowContextType = {
    skills,
    memory,
    webSearch,
    artifacts,
    fileSearch,
    agentsConfig,
    conversationId,
    storageContextKey,
    codeInterpreter,
    searchApiKeyForm,
    mcpServerManager,
  };

  return <BadgeRowContext.Provider value={value}>{children}</BadgeRowContext.Provider>;
}
