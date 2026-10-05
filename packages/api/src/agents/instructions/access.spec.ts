import { InstructionsPromptErrorCode, PermissionBits, ResourceType } from 'librechat-data-provider';
import type { AgentInstructionsPrompt } from 'librechat-data-provider';
import { ContentTraversalLimitError } from '~/protection/adapters/nested';
import { createInstructionsPromptAccess } from './access';

const groupId = '507f1f77bcf86cd799439011';
const otherGroupId = '507f1f77bcf86cd799439022';
const thirdGroupId = '507f1f77bcf86cd799439033';
const promptId = '507f191e810c19729de860ea';

const user = { id: 'user-1', role: 'USER' };

const productionLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId,
  selection: { type: 'production' },
};

const exactLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId,
  selection: { type: 'exact', promptId },
};

const otherGroupLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId: otherGroupId,
  selection: { type: 'production' },
};

const thirdGroupLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId: thirdGroupId,
  selection: { type: 'production' },
};

function buildAccess({
  visibleGroupIds = new Set<string>(),
  resolvePromptOk = true,
  canUsePromptsResult = true,
  getResourcePermissionsMap,
  resolvePrompt,
  assertAgentInstructionsContent,
  canUsePrompts,
  canManagePrompts,
}: {
  visibleGroupIds?: Set<string>;
  resolvePromptOk?: boolean;
  /** Default result for the injected `canUsePrompts` mock when the caller doesn't supply
   *  its own — most tests here are about the group-specific ACL, not the role gate. */
  canUsePromptsResult?: boolean;
  getResourcePermissionsMap?: jest.Mock;
  resolvePrompt?: jest.Mock;
  assertAgentInstructionsContent?: jest.Mock;
  canUsePrompts?: jest.Mock;
  canManagePrompts?: jest.Mock;
} = {}) {
  const logger = { warn: jest.fn(), error: jest.fn() };
  const map = jest.fn(async ({ resourceIds }: { resourceIds: string[] }) => {
    const result = new Map<string, number>();
    for (const id of resourceIds) {
      if (visibleGroupIds.has(id)) {
        result.set(id, PermissionBits.VIEW);
      }
    }
    return result;
  });
  const resolve = jest.fn(async () =>
    resolvePromptOk
      ? { ok: true as const, value: { groupId, promptId, prompt: 'hi', type: 'text' as const } }
      : {
          ok: false as const,
          error: { type: 'unavailable_selection' as const, reason: 'production' as const },
        },
  );
  const assertContent = assertAgentInstructionsContent ?? jest.fn();
  const canUse = canUsePrompts ?? jest.fn(async () => canUsePromptsResult);
  const access = createInstructionsPromptAccess({
    getResourcePermissionsMap: getResourcePermissionsMap ?? map,
    promptService: { resolvePrompt: resolvePrompt ?? resolve },
    assertAgentInstructionsContent: assertContent,
    canUsePrompts: canUse,
    canManagePrompts: canManagePrompts ?? jest.fn().mockResolvedValue(false),
    logger,
  });
  return {
    access,
    map: getResourcePermissionsMap ?? map,
    resolve: resolvePrompt ?? resolve,
    assertContent,
    canUse,
    logger,
  };
}

describe('createInstructionsPromptAccess', () => {
  describe('canViewGroup', () => {
    it('returns true when the VIEW bit is set', async () => {
      const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      await expect(
        access.canViewGroup({ userId: user.id, role: user.role, groupId }),
      ).resolves.toBe(true);
    });

    it('returns false when the bit map has no entry for the group', async () => {
      const { access } = buildAccess();
      await expect(
        access.canViewGroup({ userId: user.id, role: user.role, groupId }),
      ).resolves.toBe(false);
    });

    it('returns false when other bits are set but not VIEW', async () => {
      const { access } = buildAccess({
        getResourcePermissionsMap: jest.fn(async () => new Map([[groupId, PermissionBits.EDIT]])),
      });
      await expect(
        access.canViewGroup({ userId: user.id, role: user.role, groupId }),
      ).resolves.toBe(false);
    });

    it('queries PROMPTGROUP resources', async () => {
      const { access, map } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      await access.canViewGroup({ userId: user.id, role: user.role, groupId });
      expect(map).toHaveBeenCalledWith({
        userId: user.id,
        role: user.role,
        resourceType: ResourceType.PROMPTGROUP,
        resourceIds: [groupId],
      });
    });

    it('propagates a thrown permission-service error', async () => {
      const { access } = buildAccess({
        getResourcePermissionsMap: jest.fn(async () => {
          throw new Error('db down');
        }),
      });
      await expect(
        access.canViewGroup({ userId: user.id, role: user.role, groupId }),
      ).rejects.toThrow('db down');
    });
  });

  describe('prompt-management capability', () => {
    const manager = { ...user, tenantId: 'tenant-1', idOnTheSource: 'external-1' };
    const canManagePrompts = jest.fn().mockResolvedValue(true);

    it('allows VIEW without an ACL and preserves capability identity', async () => {
      const { access, map } = buildAccess({ canManagePrompts });
      await expect(
        access.canViewGroup({
          userId: manager.id,
          role: manager.role,
          tenantId: manager.tenantId,
          idOnTheSource: manager.idOnTheSource,
          groupId,
        }),
      ).resolves.toBe(true);
      expect(canManagePrompts).toHaveBeenCalledWith(manager);
      expect(map).not.toHaveBeenCalled();
    });

    it.each([productionLink, exactLink])(
      'allows selecting $selection.type without an ACL',
      async (next) => {
        const { access, map } = buildAccess({ canManagePrompts });
        await expect(
          access.validateLinkWrite({ user: manager, previous: null, next }),
        ).resolves.toEqual({ ok: true });
        expect(canManagePrompts).toHaveBeenCalledWith(manager);
        expect(map).not.toHaveBeenCalled();
      },
    );

    it('still requires PROMPTS USE', async () => {
      const { access } = buildAccess({ canManagePrompts, canUsePromptsResult: false });
      await expect(
        access.validateLinkWrite({ user: manager, previous: null, next: productionLink }),
      ).resolves.toEqual({
        ok: false,
        status: 403,
        code: InstructionsPromptErrorCode.FORBIDDEN,
      });
    });

    it('preserves links in the agent and every version without ACL lookups', async () => {
      const { access, map } = buildAccess({ canManagePrompts });
      const agent = {
        instructionsPrompt: productionLink,
        versions: [{ instructionsPrompt: otherGroupLink }],
      };
      await expect(access.presentForEditor({ user: manager, agent })).resolves.toBe(agent);
      await expect(
        access.presentVersionsForEditor({ user: manager, versions: agent.versions }),
      ).resolves.toEqual(agent.versions);
      expect(map).not.toHaveBeenCalled();
    });

    it('fails closed when capability lookup fails', async () => {
      const { access, map } = buildAccess({
        canManagePrompts: jest.fn().mockRejectedValue(new Error('capability outage')),
      });
      await expect(
        access.validateLinkWrite({ user: manager, previous: null, next: productionLink }),
      ).rejects.toThrow('capability outage');
      await expect(
        access.presentForEditor({ user: manager, agent: { instructionsPrompt: productionLink } }),
      ).resolves.toEqual({ instructionsPrompt: { source: 'native', restricted: true } });
      expect(map).not.toHaveBeenCalled();
    });
  });

  describe('validateLinkWrite', () => {
    it('is ok when the field is absent (no change)', async () => {
      const { access } = buildAccess();
      const result = await access.validateLinkWrite({
        user,
        previous: otherGroupLink,
        next: undefined,
      });
      expect(result).toEqual({ ok: true });
    });

    it('is ok when there was no previous link and none is requested', async () => {
      const { access } = buildAccess();
      const result = await access.validateLinkWrite({ user, previous: null, next: null });
      expect(result).toEqual({ ok: true });
    });

    it('allows re-selecting the same value even when the group is inaccessible', async () => {
      const { access, map } = buildAccess();
      const result = await access.validateLinkWrite({
        user,
        previous: otherGroupLink,
        next: { ...otherGroupLink },
      });
      expect(result).toEqual({ ok: true });
      expect(map).not.toHaveBeenCalled();
    });

    it('allows re-submitting the same removal (no previous, next null)', async () => {
      const { access, map } = buildAccess();
      const result = await access.validateLinkWrite({ user, previous: undefined, next: null });
      expect(result).toEqual({ ok: true });
      expect(map).not.toHaveBeenCalled();
    });

    describe('keep, remove, or replace an existing link — agent EDIT only', () => {
      it('allows changing away from a link to a group the editor cannot VIEW', async () => {
        // `previous` (otherGroupLink) is never checked at all — only `next`'s group
        // (groupId) needs to be viewable and resolvable.
        const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const result = await access.validateLinkWrite({
          user,
          previous: otherGroupLink,
          next: productionLink,
        });
        expect(result).toEqual({ ok: true });
      });

      it('allows removing a link to a group the editor cannot VIEW', async () => {
        const { access, map } = buildAccess();
        const result = await access.validateLinkWrite({
          user,
          previous: otherGroupLink,
          next: null,
        });
        expect(result).toEqual({ ok: true });
        // No VIEW check on `previous` at all — the lookup never runs for a removal.
        expect(map).not.toHaveBeenCalled();
      });

      it('accepts removing a link the editor can also VIEW', async () => {
        const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const result = await access.validateLinkWrite({
          user,
          previous: productionLink,
          next: null,
        });
        expect(result).toEqual({ ok: true });
      });
    });

    it('rejects a new link to a group the editor cannot VIEW (forbidden) — never checks whether it exists', async () => {
      // This module has no way to tell a hidden-but-existing group from a
      // nonexistent one: both come back absent from the permissions map, and
      // both are rejected the same way.
      const { access } = buildAccess();
      const result = await access.validateLinkWrite({
        user,
        previous: null,
        next: productionLink,
      });
      expect(result).toEqual({
        ok: false,
        status: 403,
        code: InstructionsPromptErrorCode.FORBIDDEN,
      });
    });

    it('rejects a selection that does not resolve (unavailable)', async () => {
      const { access } = buildAccess({
        visibleGroupIds: new Set([groupId]),
        resolvePromptOk: false,
      });
      const result = await access.validateLinkWrite({ user, previous: null, next: exactLink });
      expect(result).toEqual({
        ok: false,
        status: 400,
        code: InstructionsPromptErrorCode.UNAVAILABLE,
      });
    });

    it('accepts a viewable, resolvable new link (happy path)', async () => {
      const { access, resolve } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const result = await access.validateLinkWrite({ user, previous: null, next: exactLink });
      expect(result).toEqual({ ok: true });
      expect(resolve).toHaveBeenCalledWith({
        groupId,
        selection: exactLink.selection,
        filters: undefined,
      });
    });

    it('accepts changing between two viewable, resolvable links', async () => {
      const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const result = await access.validateLinkWrite({
        user,
        previous: productionLink,
        next: exactLink,
      });
      expect(result).toEqual({ ok: true });
    });

    it('forwards filters to resolvePrompt', async () => {
      const { access, resolve } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const filters = { pii: {} } as never;
      await access.validateLinkWrite({ user, previous: null, next: productionLink, filters });
      expect(resolve).toHaveBeenCalledWith({
        groupId,
        selection: productionLink.selection,
        filters,
      });
    });

    it('propagates a thrown permission-service error', async () => {
      const { access } = buildAccess({
        getResourcePermissionsMap: jest.fn(async () => {
          throw new Error('acl outage');
        }),
      });
      await expect(
        access.validateLinkWrite({ user, previous: null, next: productionLink }),
      ).rejects.toThrow('acl outage');
    });

    it('propagates a thrown prompt-service error', async () => {
      const { access } = buildAccess({
        visibleGroupIds: new Set([groupId]),
        resolvePrompt: jest.fn(async () => {
          throw new Error('prompt store outage');
        }),
      });
      await expect(
        access.validateLinkWrite({ user, previous: null, next: productionLink }),
      ).rejects.toThrow('prompt store outage');
    });

    describe('content-policy check after a successful resolve', () => {
      it('rejects a resolvable link whose content the agent-instructions policy blocks', async () => {
        const { access, assertContent } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        assertContent.mockImplementation(() => {
          throw new ContentTraversalLimitError();
        });
        const result = await access.validateLinkWrite({
          user,
          previous: null,
          next: productionLink,
        });
        expect(result).toEqual({
          ok: false,
          status: 400,
          code: InstructionsPromptErrorCode.UNAVAILABLE,
        });
        expect(assertContent).toHaveBeenCalledWith({ instructions: 'hi', filters: undefined });
      });

      it('forwards filters to the content-policy check', async () => {
        const { access, assertContent } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const filters = { agentInstructions: { pii: { types: ['EMAIL'] } } } as never;
        await access.validateLinkWrite({ user, previous: null, next: productionLink, filters });
        expect(assertContent).toHaveBeenCalledWith({ instructions: 'hi', filters });
      });

      it('propagates an assertion error the content-filter helper does not recognize', async () => {
        const { access, assertContent } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        assertContent.mockImplementation(() => {
          throw new Error('unexpected');
        });
        await expect(
          access.validateLinkWrite({ user, previous: null, next: productionLink }),
        ).rejects.toThrow('unexpected');
      });
    });

    describe('role gate (PROMPTS USE)', () => {
      it('rejects a new link when the role lacks PROMPTS USE, regardless of the group ACL result', async () => {
        // The role check and the group ACL lookup now start together; the ACL
        // lookup's own result is irrelevant here because the role failure
        // takes precedence in the returned code.
        const { access, map, canUse } = buildAccess({
          visibleGroupIds: new Set([groupId]),
          canUsePromptsResult: false,
        });
        const result = await access.validateLinkWrite({
          user,
          previous: null,
          next: productionLink,
        });
        expect(result).toEqual({
          ok: false,
          status: 403,
          code: InstructionsPromptErrorCode.FORBIDDEN,
        });
        expect(canUse).toHaveBeenCalledWith(user, undefined);
        expect(map).toHaveBeenCalledTimes(1);
      });

      it('rejects changing between two links when the role lacks PROMPTS USE', async () => {
        const { access, canUse } = buildAccess({
          visibleGroupIds: new Set([groupId]),
          canUsePromptsResult: false,
        });
        const result = await access.validateLinkWrite({
          user,
          previous: productionLink,
          next: exactLink,
        });
        expect(result).toEqual({
          ok: false,
          status: 403,
          code: InstructionsPromptErrorCode.FORBIDDEN,
        });
        expect(canUse).toHaveBeenCalledWith(user, undefined);
      });

      it('never checks the role for an unrelated edit (field absent)', async () => {
        const { access, canUse } = buildAccess({ canUsePromptsResult: false });
        const result = await access.validateLinkWrite({
          user,
          previous: otherGroupLink,
          next: undefined,
        });
        expect(result).toEqual({ ok: true });
        expect(canUse).not.toHaveBeenCalled();
      });

      it('never checks the role for removing a link', async () => {
        const { access, canUse } = buildAccess({ canUsePromptsResult: false });
        const result = await access.validateLinkWrite({
          user,
          previous: productionLink,
          next: null,
        });
        expect(result).toEqual({ ok: true });
        expect(canUse).not.toHaveBeenCalled();
      });

      it('never checks the role for re-selecting the unchanged value', async () => {
        const { access, canUse } = buildAccess({ canUsePromptsResult: false });
        const result = await access.validateLinkWrite({
          user,
          previous: otherGroupLink,
          next: { ...otherGroupLink },
        });
        expect(result).toEqual({ ok: true });
        expect(canUse).not.toHaveBeenCalled();
      });

      it('accepts a new link when the role has PROMPTS USE and the group is viewable', async () => {
        const { access, canUse } = buildAccess({
          visibleGroupIds: new Set([groupId]),
          canUsePromptsResult: true,
        });
        const result = await access.validateLinkWrite({
          user,
          previous: null,
          next: productionLink,
        });
        expect(result).toEqual({ ok: true });
        expect(canUse).toHaveBeenCalledWith(user, undefined);
      });

      it('forwards the opaque req to canUsePrompts so its role lookup can share the caller cache', async () => {
        const { access, canUse } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const req = { marker: 'request-handle' };
        await access.validateLinkWrite({ user, previous: null, next: productionLink, req });
        expect(canUse).toHaveBeenCalledWith(user, req);
      });

      it('starts the role check and the next-group VIEW check concurrently', async () => {
        /** Deferred promises let the test observe that both lookups are already
         *  in flight before either has resolved — proof the role check no longer
         *  gates the start of the VIEW lookup. */
        let resolveCanUse!: (value: boolean) => void;
        const canUsePending = new Promise<boolean>((resolve) => {
          resolveCanUse = resolve;
        });
        let resolveMap!: (value: Map<string, number>) => void;
        const mapPending = new Promise<Map<string, number>>((resolve) => {
          resolveMap = resolve;
        });
        const canUse = jest.fn(() => canUsePending);
        const map = jest.fn(() => mapPending);
        const { access } = buildAccess({ canUsePrompts: canUse, getResourcePermissionsMap: map });

        const pending = access.validateLinkWrite({ user, previous: null, next: productionLink });

        await Promise.resolve(); // Let the capability check fall through to ACLs.

        // Both lookups must already have been called — neither awaited the other.
        expect(canUse).toHaveBeenCalledTimes(1);
        expect(map).toHaveBeenCalledTimes(1);

        resolveCanUse(true);
        resolveMap(new Map([[groupId, PermissionBits.VIEW]]));
        await expect(pending).resolves.toEqual({ ok: true });
      });

      it('keeps the role failure taking precedence over a VIEW failure, even when VIEW resolves first', async () => {
        // The VIEW lookup resolves (to a passing result) well before the role
        // check does; the returned code must still be the role-failure code.
        let resolveCanUse!: (value: boolean) => void;
        const canUsePending = new Promise<boolean>((resolve) => {
          resolveCanUse = resolve;
        });
        const canUse = jest.fn(() => canUsePending);
        const { access } = buildAccess({
          visibleGroupIds: new Set([groupId]),
          canUsePrompts: canUse,
        });

        const pending = access.validateLinkWrite({ user, previous: null, next: productionLink });
        await Promise.resolve(); // let the VIEW lookup (a resolved mock) settle first
        resolveCanUse(false);

        await expect(pending).resolves.toEqual({
          ok: false,
          status: 403,
          code: InstructionsPromptErrorCode.FORBIDDEN,
        });
      });
    });
  });

  describe('presentForEditor', () => {
    it('leaves the agent untouched when there is no link', async () => {
      const { access } = buildAccess();
      const agent = { id: 'a1', instructionsPrompt: null };
      await expect(access.presentForEditor({ user, agent })).resolves.toBe(agent);
    });

    it('leaves a visible link untouched', async () => {
      const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const agent = { id: 'a1', instructionsPrompt: productionLink };
      await expect(access.presentForEditor({ user, agent })).resolves.toBe(agent);
    });

    it('replaces an inaccessible link with a restricted stub', async () => {
      const { access } = buildAccess();
      const agent = { id: 'a1', name: 'Agent', instructionsPrompt: otherGroupLink };
      const result = await access.presentForEditor({ user, agent });
      expect(result).toEqual({
        id: 'a1',
        name: 'Agent',
        instructionsPrompt: { source: 'native', restricted: true },
      });
    });

    it('stubs a link to a deleted group the same as a hidden one, with no group-existence read', async () => {
      // A deleted group has no ACL entries, so it comes back not-visible —
      // same as any other hidden group. There is no separate existence check
      // (`getPromptGroup`) that could distinguish the two.
      const { access } = buildAccess();
      const agent = { id: 'a1', name: 'Agent', instructionsPrompt: otherGroupLink };
      const result = await access.presentForEditor({ user, agent });
      expect(result).toEqual({
        id: 'a1',
        name: 'Agent',
        instructionsPrompt: { source: 'native', restricted: true },
      });
    });

    it('is idempotent on an already-restricted stub', async () => {
      const { access, map } = buildAccess();
      const agent = {
        id: 'a1',
        instructionsPrompt: { source: 'native' as const, restricted: true as const },
      };
      const result = await access.presentForEditor({ user, agent });
      expect(result).toBe(agent);
      expect(map).not.toHaveBeenCalled();
    });

    it('fails closed on a thrown permission-service error: stubs the link and logs, never throws', async () => {
      const { access, logger } = buildAccess({
        getResourcePermissionsMap: jest.fn(async () => {
          throw new Error('acl outage');
        }),
      });
      const agent = { id: 'a1', name: 'Agent', instructionsPrompt: otherGroupLink };
      const result = await access.presentForEditor({ user, agent });
      expect(result).toEqual({
        id: 'a1',
        name: 'Agent',
        instructionsPrompt: { source: 'native', restricted: true },
      });
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [message, meta] = logger.error.mock.calls[0];
      expect(message).toContain('[createInstructionsPromptAccess]');
      expect(JSON.stringify(meta)).not.toContain('acl outage');
    });

    it('fails closed across both the top-level link and every version snapshot', async () => {
      const { access } = buildAccess({
        getResourcePermissionsMap: jest.fn(async () => {
          throw new Error('acl outage');
        }),
      });
      const agent = {
        id: 'a1',
        instructionsPrompt: productionLink,
        versions: [
          { name: 'v1', instructionsPrompt: otherGroupLink },
          { name: 'v2', instructionsPrompt: null },
        ],
      };
      const result = await access.presentForEditor({ user, agent });
      expect(result).toEqual({
        id: 'a1',
        instructionsPrompt: { source: 'native', restricted: true },
        versions: [
          { name: 'v1', instructionsPrompt: { source: 'native', restricted: true } },
          { name: 'v2', instructionsPrompt: null },
        ],
      });
    });

    describe('versions[] redaction', () => {
      it('leaves an agent with no links (top-level or versioned) untouched', async () => {
        const { access, map } = buildAccess();
        const agent = {
          id: 'a1',
          instructionsPrompt: null,
          versions: [{ name: 'v1', instructionsPrompt: null }],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toBe(agent);
        expect(map).not.toHaveBeenCalled();
      });

      it('redacts an inaccessible link inside a version snapshot, leaving a visible top-level link intact', async () => {
        const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const agent = {
          id: 'a1',
          instructionsPrompt: productionLink,
          versions: [
            { name: 'v1', instructionsPrompt: otherGroupLink },
            { name: 'v2', instructionsPrompt: productionLink },
          ],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toEqual({
          id: 'a1',
          instructionsPrompt: productionLink,
          versions: [
            {
              name: 'v1',
              instructionsPrompt: { source: 'native', restricted: true, matchesCurrent: false },
            },
            { name: 'v2', instructionsPrompt: productionLink },
          ],
        });
      });

      it('redacts the top-level link while leaving an accessible version snapshot intact', async () => {
        const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const agent = {
          id: 'a1',
          instructionsPrompt: otherGroupLink,
          versions: [{ name: 'v1', instructionsPrompt: productionLink }],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toEqual({
          id: 'a1',
          instructionsPrompt: { source: 'native', restricted: true },
          versions: [{ name: 'v1', instructionsPrompt: productionLink }],
        });
      });

      it('leaves an already-restricted version snapshot untouched', async () => {
        const { access } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const agent = {
          id: 'a1',
          instructionsPrompt: productionLink,
          versions: [
            {
              name: 'v1',
              instructionsPrompt: { source: 'native' as const, restricted: true as const },
            },
          ],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toBe(agent);
      });

      it('batches every distinct groupId (top-level and versioned) into one permission lookup', async () => {
        const { access, map } = buildAccess({ visibleGroupIds: new Set([groupId]) });
        const agent = {
          id: 'a1',
          instructionsPrompt: productionLink,
          versions: [
            { name: 'v1', instructionsPrompt: otherGroupLink },
            { name: 'v2', instructionsPrompt: thirdGroupLink },
            { name: 'v3', instructionsPrompt: otherGroupLink },
          ],
        };
        await access.presentForEditor({ user, agent });
        expect(map).toHaveBeenCalledTimes(1);
        const [{ resourceIds }] = map.mock.calls[0];
        expect(new Set(resourceIds)).toEqual(new Set([groupId, otherGroupId, thirdGroupId]));
      });

      it('redacts a version snapshot whose group has been deleted, the same as a hidden one', async () => {
        const { access } = buildAccess();
        const agent = {
          id: 'a1',
          instructionsPrompt: null,
          versions: [
            { name: 'v1', instructionsPrompt: otherGroupLink },
            { name: 'v2', instructionsPrompt: thirdGroupLink },
          ],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toEqual({
          id: 'a1',
          instructionsPrompt: null,
          versions: [
            {
              name: 'v1',
              instructionsPrompt: { source: 'native', restricted: true, matchesCurrent: false },
            },
            {
              name: 'v2',
              instructionsPrompt: { source: 'native', restricted: true, matchesCurrent: false },
            },
          ],
        });
      });
    });

    describe('matchesCurrent on a redacted version stub', () => {
      it('flags a redacted version as matching the current link (same group, same selection)', async () => {
        const { access } = buildAccess();
        const agent = {
          id: 'a1',
          instructionsPrompt: otherGroupLink,
          versions: [{ name: 'v1', instructionsPrompt: otherGroupLink }],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toEqual({
          id: 'a1',
          instructionsPrompt: { source: 'native', restricted: true },
          versions: [
            {
              name: 'v1',
              instructionsPrompt: { source: 'native', restricted: true, matchesCurrent: true },
            },
          ],
        });
      });

      it('flags a redacted version as not matching when its group differs from the current link', async () => {
        const { access } = buildAccess();
        const agent = {
          id: 'a1',
          instructionsPrompt: otherGroupLink,
          versions: [{ name: 'v1', instructionsPrompt: thirdGroupLink }],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toEqual({
          id: 'a1',
          instructionsPrompt: { source: 'native', restricted: true },
          versions: [
            {
              name: 'v1',
              instructionsPrompt: { source: 'native', restricted: true, matchesCurrent: false },
            },
          ],
        });
      });

      it('flags a redacted version as not matching when only the selection differs within the same group', async () => {
        const { access } = buildAccess();
        const agent = {
          id: 'a1',
          instructionsPrompt: productionLink,
          versions: [{ name: 'v1', instructionsPrompt: exactLink }],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toEqual({
          id: 'a1',
          instructionsPrompt: { source: 'native', restricted: true },
          versions: [
            {
              name: 'v1',
              instructionsPrompt: { source: 'native', restricted: true, matchesCurrent: false },
            },
          ],
        });
      });

      it('flags an older version as matching current after a revert, even though a later snapshot does not', async () => {
        // `revertAgentVersion` `$set`s the document without appending a new version,
        // so after a revert the current link can equal an *older* entry while the
        // latest-appended entry (still the pre-revert link) does not.
        const { access } = buildAccess();
        const agent = {
          id: 'a1',
          instructionsPrompt: otherGroupLink,
          versions: [
            { name: 'older', instructionsPrompt: otherGroupLink },
            { name: 'latest', instructionsPrompt: thirdGroupLink },
          ],
        };
        const result = await access.presentForEditor({ user, agent });
        expect(result).toEqual({
          id: 'a1',
          instructionsPrompt: { source: 'native', restricted: true },
          versions: [
            {
              name: 'older',
              instructionsPrompt: { source: 'native', restricted: true, matchesCurrent: true },
            },
            {
              name: 'latest',
              instructionsPrompt: { source: 'native', restricted: true, matchesCurrent: false },
            },
          ],
        });
      });
    });
  });

  describe('presentVersionsForEditor', () => {
    it('returns the versions unchanged when none carry a link', async () => {
      const { access, map } = buildAccess();
      const versions = [{ name: 'v1', instructionsPrompt: null }, { name: 'v2' }];
      const result = await access.presentVersionsForEditor({ user, versions });
      expect(result).toEqual(versions);
      expect(map).not.toHaveBeenCalled();
    });

    it('redacts only the snapshots whose link the editor cannot VIEW', async () => {
      const { access, map } = buildAccess({ visibleGroupIds: new Set([groupId]) });
      const versions = [
        { name: 'v1', instructionsPrompt: productionLink },
        { name: 'v2', instructionsPrompt: otherGroupLink },
      ];
      const result = await access.presentVersionsForEditor({ user, versions });
      expect(result).toEqual([
        { name: 'v1', instructionsPrompt: productionLink },
        { name: 'v2', instructionsPrompt: { source: 'native', restricted: true } },
      ]);
      expect(map).toHaveBeenCalledTimes(1);
    });

    it('leaves an already-restricted snapshot untouched', async () => {
      const { access } = buildAccess();
      const versions = [
        {
          name: 'v1',
          instructionsPrompt: { source: 'native' as const, restricted: true as const },
        },
      ];
      const result = await access.presentVersionsForEditor({ user, versions });
      expect(result[0]).toBe(versions[0]);
    });

    it('redacts a snapshot whose group has been deleted, the same as a hidden one', async () => {
      const { access } = buildAccess();
      const versions = [{ name: 'v1', instructionsPrompt: otherGroupLink }];
      const result = await access.presentVersionsForEditor({ user, versions });
      expect(result).toEqual([
        { name: 'v1', instructionsPrompt: { source: 'native', restricted: true } },
      ]);
    });

    it('fails closed on a thrown permission-service error: stubs every link and logs, never throws', async () => {
      const { access, logger } = buildAccess({
        getResourcePermissionsMap: jest.fn(async () => {
          throw new Error('acl outage');
        }),
      });
      const versions = [
        { name: 'v1', instructionsPrompt: otherGroupLink },
        { name: 'v2', instructionsPrompt: null },
      ];
      const result = await access.presentVersionsForEditor({ user, versions });
      expect(result).toEqual([
        { name: 'v1', instructionsPrompt: { source: 'native', restricted: true } },
        { name: 'v2', instructionsPrompt: null },
      ]);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    describe('matchesCurrent', () => {
      it('flags a redacted snapshot that matches the given current link', async () => {
        const { access } = buildAccess();
        const versions = [{ name: 'v1', instructionsPrompt: otherGroupLink }];
        const result = await access.presentVersionsForEditor({
          user,
          versions,
          currentLink: otherGroupLink,
        });
        expect(result).toEqual([
          {
            name: 'v1',
            instructionsPrompt: { source: 'native', restricted: true, matchesCurrent: true },
          },
        ]);
      });

      it('flags a redacted snapshot that does not match the given current link', async () => {
        const { access } = buildAccess();
        const versions = [{ name: 'v1', instructionsPrompt: otherGroupLink }];
        const result = await access.presentVersionsForEditor({
          user,
          versions,
          currentLink: thirdGroupLink,
        });
        expect(result).toEqual([
          {
            name: 'v1',
            instructionsPrompt: { source: 'native', restricted: true, matchesCurrent: false },
          },
        ]);
      });

      it('omits the flag entirely when the caller passes no current link to compare against', async () => {
        const { access } = buildAccess();
        const versions = [{ name: 'v1', instructionsPrompt: otherGroupLink }];
        const result = await access.presentVersionsForEditor({ user, versions });
        expect(result).toEqual([
          { name: 'v1', instructionsPrompt: { source: 'native', restricted: true } },
        ]);
      });
    });
  });
});
