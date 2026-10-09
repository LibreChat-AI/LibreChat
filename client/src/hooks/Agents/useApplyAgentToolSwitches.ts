import { useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { useRecoilCallback, useSetRecoilState } from 'recoil';
import {
  Constants,
  LocalStorageKeys,
  getAgentToolSwitches,
  switchableBuiltinTools,
} from 'librechat-data-provider';
import type { Agent, TEphemeralAgent, SwitchableBuiltinTool } from 'librechat-data-provider';
import { ephemeralAgentByConvoId, mcpValuesAtomFamily } from '~/store';
import { applyAgentToolSwitchDefaults } from '~/utils';
import { setTimestamp } from '~/utils/timestamps';

export function useApplyAgentToolSwitches({
  agent,
  conversationId,
}: {
  agent?: Pick<Agent, 'id' | 'tools' | 'tool_options'> | null;
  conversationId?: string | null;
}) {
  const convoId = conversationId ?? Constants.NEW_CONVO;
  const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(convoId));
  const [mcpValues, setMCPValues] = useAtom(mcpValuesAtomFamily(convoId));
  const getEphemeralAgent = useRecoilCallback(
    ({ snapshot }) =>
      () =>
        snapshot.getLoadable(ephemeralAgentByConvoId(convoId)).contents as TEphemeralAgent | null,
    [convoId],
  );
  const seededRef = useRef<{
    convoId: string;
    seedKey: string;
    builtins: SwitchableBuiltinTool[];
    servers: string[];
  } | null>(null);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const agentId = agent?.id;
  /** The saved agent's cache entry is replaced in place when its creator edits it,
   *  so reseed on a change in the switch config itself, not just the agent id. */
  const agentSwitches = agent ? getAgentToolSwitches(agent) : null;
  const switchesKey = agentSwitches ? JSON.stringify(agentSwitches) : '';
  const hasMCPSwitches = agentSwitches != null && Object.keys(agentSwitches.mcp).length > 0;

  useEffect(() => {
    const current = agentRef.current;
    if (!current) {
      return;
    }
    const switches = getAgentToolSwitches(current);
    const switchableBuiltins = switchableBuiltinTools.filter((tool) => tool in switches.builtins);
    const switchableServers = Object.keys(switches.mcp);
    const previousSeed = seededRef.current;
    const seedKey = `${agentId}:${switchesKey}`;
    seededRef.current = {
      convoId,
      seedKey,
      builtins: switchableBuiltins,
      servers: switchableServers,
    };
    /** Another agent picked in this same chat leaves its switches behind; drop them. */
    const stale =
      previousSeed?.convoId === convoId && previousSeed.seedKey !== seedKey ? previousSeed : null;
    const withoutStale = (previous: TEphemeralAgent | null): TEphemeralAgent | null => {
      if (!stale || !previous) {
        return previous;
      }
      const next: TEphemeralAgent = { ...previous };
      for (const tool of stale.builtins) {
        delete next[tool];
      }
      if (Array.isArray(next.mcp)) {
        next.mcp = next.mcp.filter((name) => !stale.servers.includes(name));
      }
      return next;
    };
    if (switchableBuiltins.length === 0 && switchableServers.length === 0) {
      if (stale) {
        setEphemeralAgent(withoutStale);
      }
      return;
    }
    /** A new chat that just received its real id already carries the user's
     *  choices, copied over from the submission; persist them instead of reseeding. */
    const carried =
      previousSeed?.convoId === Constants.NEW_CONVO &&
      previousSeed.seedKey === seedKey &&
      convoId !== Constants.NEW_CONVO
        ? getEphemeralAgent()
        : null;
    if (carried) {
      if (Array.isArray(carried.mcp)) {
        setMCPValues(carried.mcp);
      }
      return;
    }
    const seeded = applyAgentToolSwitchDefaults({
      agent: current,
      convoId,
      isNewConvo: convoId === Constants.NEW_CONVO,
    });
    setEphemeralAgent((current) => {
      const previous = withoutStale(current);
      return {
        ...previous,
        ...seeded,
        ...(seeded.mcp && {
          mcp: [
            ...(previous?.mcp ?? []).filter((name) => !switchableServers.includes(name)),
            ...seeded.mcp,
          ],
        }),
      };
    });
  }, [agentId, switchesKey, convoId, setEphemeralAgent, setMCPValues, getEphemeralAgent]);

  /** An explicit empty list overrides the creator's default-on servers, so it needs a
   *  fresh timestamp to survive startup cleanup; plain chats only stamp non-empty lists. */
  useEffect(() => {
    const storageKey = `${LocalStorageKeys.LAST_MCP_}${convoId}`;
    if (
      !hasMCPSwitches ||
      convoId === Constants.NEW_CONVO ||
      localStorage.getItem(storageKey) === null
    ) {
      return;
    }
    setTimestamp(storageKey);
  }, [hasMCPSwitches, convoId, mcpValues]);
}
