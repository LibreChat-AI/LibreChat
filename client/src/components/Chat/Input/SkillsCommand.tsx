import { memo, useEffect, useMemo, useCallback } from 'react';
import { ScrollText } from 'lucide-react';
import { useSetRecoilState } from 'recoil';
import { useSetAtom, useAtomValue } from 'jotai';
import { SkillsPopover } from '@librechat/chat/components';
import { SkillsScope, resolveAgentSkillsScope } from 'librechat-data-provider';
import { pendingManualSkillsByConvoId, showSkillsPopoverFamily } from '@librechat/chat/react';
import type { TSkillSummary } from 'librechat-data-provider';
import type { MentionOption } from '~/common';
import { useLocalize, useSkillActiveState } from '~/hooks';
import { useSkillsInfiniteQuery } from '~/data-provider';
import { useAgentsMapContext } from '~/Providers';
import { ephemeralAgentByConvoId } from '~/store';
import { isEphemeralAgent } from '~/common';

const skillIcon = <ScrollText className="icon-md text-status-info" />;

/**
 * Determines whether a skill should appear in the `$` command popover.
 * Reads the persisted `userInvocable` field (mirrors the `user-invocable`
 * frontmatter). Defaults to visible when the field is absent so older
 * skills authored before Phase 6 stay user-invocable without a migration;
 * only an explicit `false` hides them.
 */
export function isUserInvocable(skill: TSkillSummary): boolean {
  return skill.userInvocable !== false;
}

/**
 * Filters the skills list down to what should appear in the `$` popover.
 * Composes three rules, short-circuiting on the cheapest check first:
 *
 * 1. Agent scope — mirrors backend `scopeSkillIds` semantics:
 *    - `null` / `undefined` → no scope filter (ephemeral convo, or agent
 *      without a `skills` field configured).
 *    - `[]` → explicit opt-out, nothing passes.
 *    - non-empty → intersection with the agent's configured skill ids.
 * 2. Active state — per-user ownership-aware toggle.
 * 3. Invocation mode — `manual` / `both` / undefined are visible; `auto`
 *    is model-only and hidden.
 *
 * Pure function; exported so tests can exercise the filter in isolation
 * without rendering the component.
 */
export function filterSkillsForPopover(
  skills: TSkillSummary[],
  ctx: {
    agentSkillIds: string[] | null | undefined;
    isActive: (skill: Pick<TSkillSummary, '_id' | 'author' | 'source'>) => boolean;
  },
): TSkillSummary[] {
  const { agentSkillIds, isActive } = ctx;
  if (agentSkillIds != null && agentSkillIds.length === 0) {
    return [];
  }
  const agentSet =
    agentSkillIds != null && agentSkillIds.length > 0 ? new Set(agentSkillIds) : null;
  const result: TSkillSummary[] = [];
  for (const skill of skills) {
    if (agentSet && !agentSet.has(skill._id)) {
      continue;
    }
    if (!isActive(skill)) {
      continue;
    }
    if (!isUserInvocable(skill)) {
      continue;
    }
    result.push(skill);
  }
  return result;
}

function SkillsCommandContent({
  index,
  textAreaRef,
  conversationId,
  agentId,
}: {
  index: number;
  textAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  conversationId: string;
  agentId?: string | null;
}) {
  const localize = useLocalize();
  const setShowSkillsPopover = useSetAtom(showSkillsPopoverFamily(index));
  const setEphemeralAgent = useSetRecoilState(ephemeralAgentByConvoId(conversationId));
  const setPendingManualSkills = useSetAtom(pendingManualSkillsByConvoId(conversationId));

  const agentsMap = useAgentsMapContext();
  const { isActive } = useSkillActiveState();

  /* Resolve the per-agent skill scope. Mirrors backend
     `resolveAgentScopedSkillIds`: ephemeral agents always see the full
     catalog (picking any skill flips `ephemeralAgent.skills = true` and
     activates for the turn); persisted agents gate on the builder's
     `skills_enabled` master toggle and explicit catalog scope. Legacy agents
     without a scope retain empty allowlist = full catalog. Persisted agents fail closed during the
     `agentsMap` hydration window so the user cannot pick a skill the
     backend will then refuse, and again when the map is authoritative
     but the agent isn't in it (deleted, or VIEW revoked mid-session).
     `agentId` is threaded in as a prop so this component stays
     memoizable. */
  const agentSkillIds = useMemo<string[] | null | undefined>(() => {
    if (!agentId || isEphemeralAgent(agentId)) {
      return undefined;
    }
    if (!agentsMap) {
      return [];
    }
    const agent = agentsMap[agentId];
    if (!agent) {
      return [];
    }
    if (agent.skills_enabled !== true) {
      return [];
    }
    const scope = resolveAgentSkillsScope(agent.skills, agent.skills_enabled, agent.skills_scope);
    if (scope === SkillsScope.none) {
      return [];
    }
    if (scope === SkillsScope.all) {
      return undefined;
    }
    return agent.skills ?? [];
  }, [agentId, agentsMap]);

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSkillsInfiniteQuery({ limit: 50 });

  /* Auto-fetch all pages so client-side search covers the full catalog,
     not just the first page. The skills API is server-side capped. */
  useEffect(() => {
    if (isError) {
      return;
    }
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  const skillOptions: MentionOption[] = useMemo(() => {
    if (!data?.pages) {
      return [];
    }
    const allSkills: TSkillSummary[] = [];
    for (const page of data.pages) {
      for (const skill of page.skills) {
        allSkills.push(skill);
      }
    }
    const filtered = filterSkillsForPopover(allSkills, { agentSkillIds, isActive });
    const options: MentionOption[] = [];
    for (const skill of filtered) {
      options.push({
        label: skill.displayTitle ?? skill.name,
        value: skill.name,
        description: skill.description,
        type: 'skill',
        icon: skillIcon,
      });
    }
    return options;
  }, [data?.pages, agentSkillIds, isActive]);

  const handleSelect = useCallback(
    (mention: { value: string }) => {
      setEphemeralAgent((prev) => {
        if (prev?.skills) {
          return prev;
        }
        return { ...(prev || {}), skills: true };
      });

      /* Structured channel for manual skill invocations. The submit
         pipeline reads this and primes SKILL.md as a meta user message
         before the LLM turn — no textarea-level marker is needed, and
         injecting `$skill-name ` as text would mislead users into thinking
         free-form text invocation is supported. Visual confirmation after
         submit comes from `SkillPills` on the user message bubble
         until the live skill-card stream takes over. */
      setPendingManualSkills((prev) =>
        prev.includes(mention.value) ? prev : [...prev, mention.value],
      );
    },
    [setEphemeralAgent, setPendingManualSkills],
  );

  return (
    <SkillsPopover
      textAreaRef={textAreaRef}
      placeholder={localize('com_ui_skills_command_placeholder')}
      skills={skillOptions}
      isLoading={isLoading || isFetchingNextPage}
      isError={isError}
      notices={{
        error: localize('com_ui_skills_load_error'),
        empty: localize('com_ui_skills_empty'),
        noMatch: localize('com_ui_no_skills_found'),
      }}
      onSelectSkill={handleSelect}
      onClose={() => setShowSkillsPopover(false)}
    />
  );
}

const SkillsCommand = memo(function SkillsCommand({
  index,
  textAreaRef,
  conversationId,
  agentId,
}: {
  index: number;
  textAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  conversationId: string;
  agentId?: string | null;
}) {
  const show = useAtomValue(showSkillsPopoverFamily(index));
  if (!show) {
    return null;
  }
  return (
    <SkillsCommandContent
      index={index}
      textAreaRef={textAreaRef}
      conversationId={conversationId}
      agentId={agentId}
    />
  );
});

export default SkillsCommand;
