import type { AppConfig } from '@librechat/data-schemas';
import {
  resolveConversationCodeEnvironmentDecision,
  resolveAdmittedCodeEnvironmentDecision,
  resolveConversationCodeEnvironmentMove,
  resolvePersistableCodeEnvironmentDecision,
} from './decision';
import { CodeWorkspaceSelectionError } from './capabilities';

const selection = { environmentId: 'personal-vm', workspaceId: 'project-a' };

describe('resolveConversationCodeEnvironmentDecision', () => {
  it('defaults a new conversation without a selection to no attached environment', () => {
    expect(resolveConversationCodeEnvironmentDecision({ conversationId: 'new' })).toEqual({
      mode: 'without_attached',
    });
  });

  it('accepts and canonicalizes a new attached decision', () => {
    expect(
      resolveConversationCodeEnvironmentDecision({
        conversationId: 'new',
        requestedMode: 'attached',
        requestedSelections: [{ environmentId: 'team-vm', workspaceId: 'project-b' }, selection],
      }),
    ).toEqual({
      mode: 'attached',
      codeWorkspaces: [selection, { environmentId: 'team-vm', workspaceId: 'project-b' }],
    });
  });

  it('infers legacy persisted decisions', () => {
    expect(
      resolveConversationCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        conversation: { conversationId: 'conversation-1', codeWorkspaces: [selection] },
      }),
    ).toEqual({ mode: 'attached', codeWorkspaces: [selection] });
    expect(
      resolveConversationCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        conversation: { conversationId: 'conversation-1' },
      }),
    ).toEqual({ mode: 'without_attached' });
  });

  /* A chat started by an agent that never ran code stores neither field. Sealing that state made
   * switching it to a coding agent reject the first workspace its owner picked. */
  it('lets a saved conversation that never decided establish a decision', () => {
    expect(
      resolveConversationCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        requestedMode: 'attached',
        requestedSelections: [selection],
        conversation: { conversationId: 'conversation-1' },
      }),
    ).toEqual({ mode: 'attached', codeWorkspaces: [selection] });
    expect(
      resolveConversationCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        requestedMode: 'attached',
        requestedSelections: [selection],
        conversation: { conversationId: 'conversation-1', codeWorkspaces: [] },
      }),
    ).toEqual({ mode: 'attached', codeWorkspaces: [selection] });
  });

  it('allows an identical retry of a persisted decision', () => {
    expect(
      resolveConversationCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        requestedMode: 'attached',
        requestedSelections: [selection],
        conversation: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [selection],
        },
      }),
    ).toEqual({ mode: 'attached', codeWorkspaces: [selection] });
  });

  it.each([
    {
      requestedMode: 'without_attached',
      requestedSelections: undefined,
    },
    {
      requestedMode: 'attached',
      requestedSelections: [{ environmentId: 'personal-vm', workspaceId: 'project-b' }],
    },
  ])('rejects a conflicting change to a persisted attached decision', (requested) => {
    expect(() =>
      resolveConversationCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        ...requested,
        conversation: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [selection],
        },
      }),
    ).toThrow(expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({ reason: 'locked' }));
  });

  it('rejects attaching a workspace to a conversation locked without one', () => {
    expect(() =>
      resolveConversationCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        requestedMode: 'attached',
        requestedSelections: [selection],
        conversation: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'without_attached',
        },
      }),
    ).toThrow(expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({ reason: 'locked' }));
  });

  it('rejects contradictory decision fields', () => {
    expect(() =>
      resolveConversationCodeEnvironmentDecision({
        conversationId: 'new',
        requestedMode: 'without_attached',
        requestedSelections: [selection],
      }),
    ).toThrow(expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({ reason: 'invalid' }));
    expect(() =>
      resolveConversationCodeEnvironmentDecision({
        conversationId: 'new',
        requestedMode: 'attached',
      }),
    ).toThrow(
      expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({ reason: 'required' }),
    );
  });

  it('rejects an invalid persisted mode instead of treating it as attached', () => {
    expect(() =>
      resolveConversationCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        conversation: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'future-mode' as never,
          codeWorkspaces: [selection],
        },
      }),
    ).toThrow(expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({ reason: 'invalid' }));
  });
});

describe('resolveConversationCodeEnvironmentMove', () => {
  const mac = { environmentId: 'mac', workspaceId: 'primary' };
  const vm = { environmentId: 'vm', workspaceId: 'projects' };
  const locked = expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({
    reason: 'locked',
  });
  const sealedOn = (...codeWorkspaces: (typeof mac)[]) => ({
    conversationId: 'conversation-1',
    codeEnvironmentMode: 'attached' as const,
    codeWorkspaces,
  });

  it('replaces an environment the agents stopped using with the one they use now', () => {
    expect(
      resolveConversationCodeEnvironmentMove({
        conversation: sealedOn(mac),
        from: [mac],
        to: [vm],
      }),
    ).toEqual({ mode: 'attached', codeWorkspaces: [vm] });
  });

  it('carries a covered environment over unchanged while adding a new one', () => {
    const team = { environmentId: 'team', workspaceId: 'shared' };
    expect(
      resolveConversationCodeEnvironmentMove({
        conversation: sealedOn(team),
        from: [team],
        to: [vm, team],
      }),
    ).toEqual({ mode: 'attached', codeWorkspaces: [team, vm] });
  });

  it('moves a legacy decision inferred from its selections', () => {
    expect(
      resolveConversationCodeEnvironmentMove({
        conversation: { conversationId: 'conversation-1', codeWorkspaces: [mac] },
        from: [mac],
        to: [vm],
      }),
    ).toEqual({ mode: 'attached', codeWorkspaces: [vm] });
  });

  it('accepts an explicit workspace replacement for the caller to verify against live status', () => {
    const replacement = { environmentId: 'mac', workspaceId: 'canary' };
    expect(
      resolveConversationCodeEnvironmentMove({
        conversation: sealedOn(mac, vm),
        from: [mac, vm],
        to: [replacement, vm],
      }),
    ).toEqual({ mode: 'attached', codeWorkspaces: [replacement, vm] });
  });

  it('drops an environment the agents stopped using without adding one', () => {
    const team = { environmentId: 'team', workspaceId: 'shared' };
    expect(
      resolveConversationCodeEnvironmentMove({
        conversation: sealedOn(mac, team),
        from: [mac, team],
        to: [team],
      }),
    ).toEqual({ mode: 'attached', codeWorkspaces: [team] });
  });

  it('rejects a move that changes nothing', () => {
    expect(() =>
      resolveConversationCodeEnvironmentMove({
        conversation: sealedOn(mac),
        from: [mac],
        to: [mac],
      }),
    ).toThrow(locked);
  });

  it('attaches an environment to a chat that recorded running without one', () => {
    expect(
      resolveConversationCodeEnvironmentMove({
        conversation: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'without_attached',
        },
        from: [],
        to: [vm, mac],
      }),
    ).toEqual({ mode: 'attached', codeWorkspaces: [mac, vm] });
  });

  /* An attach still replaces a decision the client has seen, and a chat that recorded none is not
   * sealed at all: its next turn records one, so the composer selects instead of transitioning. */
  it('rejects attaching against a decision the conversation does not hold', () => {
    expect(() =>
      resolveConversationCodeEnvironmentMove({
        conversation: { conversationId: 'conversation-1' },
        from: [],
        to: [vm],
      }),
    ).toThrow(locked);
    expect(() =>
      resolveConversationCodeEnvironmentMove({
        conversation: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'without_attached',
        },
        from: [mac],
        to: [vm],
      }),
    ).toThrow(locked);
  });

  it('leaves every attached environment when the target set is empty', () => {
    expect(
      resolveConversationCodeEnvironmentMove({
        conversation: sealedOn(mac, vm),
        from: [mac, vm],
        to: [],
      }),
    ).toEqual({ mode: 'without_attached' });
  });

  it.each([
    { conversationId: 'conversation-1', codeEnvironmentMode: 'without_attached' as const },
    { conversationId: 'conversation-1' },
  ])('has nothing to detach without an attached decision: %j', (stored) => {
    expect(() =>
      resolveConversationCodeEnvironmentMove({ conversation: stored, from: [], to: [] }),
    ).toThrow(locked);
  });

  it('rejects a client acting on a decision it has not seen', () => {
    expect(() =>
      resolveConversationCodeEnvironmentMove({ conversation: sealedOn(vm), from: [mac], to: [vm] }),
    ).toThrow(locked);
  });

  it.each([undefined, [vm, { ...vm, workspaceId: 'other' }], [{ environmentId: 'vm' }]])(
    'rejects a malformed target: %j',
    (to) => {
      expect(() =>
        resolveConversationCodeEnvironmentMove({ conversation: sealedOn(mac), from: [mac], to }),
      ).toThrow(
        expect.objectContaining<Partial<CodeWorkspaceSelectionError>>({ reason: 'invalid' }),
      );
    },
  );
});

describe('resolvePersistableCodeEnvironmentDecision', () => {
  const mac = { environmentId: 'mac', workspaceId: 'primary' };
  const vm = { environmentId: 'vm', workspaceId: 'projects' };

  it('persists the decision a new conversation establishes', () => {
    expect(
      resolvePersistableCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        decision: { mode: 'attached', codeWorkspaces: [mac] },
      }),
    ).toEqual({ codeEnvironmentMode: 'attached', codeWorkspaces: [mac] });
    expect(
      resolvePersistableCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        decision: { mode: 'without_attached' },
      }),
    ).toEqual({ codeEnvironmentMode: 'without_attached' });
  });

  it('records the whole decision a saved conversation establishes for the first time', () => {
    /* Selections included: an `attached` mode stored without them fails the next turn's
     * validation, which requires a non-empty selection set. */
    expect(
      resolvePersistableCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        decision: { mode: 'attached', codeWorkspaces: [mac] },
        conversation: { conversationId: 'conversation-1' },
      }),
    ).toEqual({ codeEnvironmentMode: 'attached', codeWorkspaces: [mac] });
  });

  it('never writes a run-start decision over a stored one that a move replaced', () => {
    expect(
      resolvePersistableCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        decision: { mode: 'attached', codeWorkspaces: [mac] },
        conversation: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [vm],
        },
      }),
    ).toEqual({});
  });

  it('records the mode a legacy row inferred without rewriting its selections', () => {
    expect(
      resolvePersistableCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        decision: { mode: 'attached', codeWorkspaces: [mac] },
        conversation: { conversationId: 'conversation-1', codeWorkspaces: [vm] },
      }),
    ).toEqual({ codeEnvironmentMode: 'attached' });
  });

  it('treats a resolved conversation for another id as a new conversation', () => {
    expect(
      resolvePersistableCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        decision: { mode: 'attached', codeWorkspaces: [mac] },
        conversation: {
          conversationId: 'another-conversation',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [vm],
        },
      }),
    ).toEqual({ codeEnvironmentMode: 'attached', codeWorkspaces: [mac] });
  });

  it('falls back to request fields for a caller that never resolved a decision', () => {
    expect(
      resolvePersistableCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        requested: { codeEnvironmentMode: 'attached', codeWorkspaces: [mac] },
      }),
    ).toEqual({ codeEnvironmentMode: 'attached', codeWorkspaces: [mac] });
  });

  it('never writes a request fallback over a stored decision', () => {
    expect(
      resolvePersistableCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        requested: { codeEnvironmentMode: 'attached', codeWorkspaces: [mac] },
        conversation: {
          conversationId: 'conversation-1',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [vm],
        },
      }),
    ).toEqual({});
  });

  it('prefers the validated decision over request fields', () => {
    expect(
      resolvePersistableCodeEnvironmentDecision({
        conversationId: 'conversation-1',
        decision: { mode: 'without_attached' },
        requested: { codeEnvironmentMode: 'attached', codeWorkspaces: [mac] },
      }),
    ).toEqual({ codeEnvironmentMode: 'without_attached' });
  });

  it('persists nothing without a validated decision', () => {
    expect(resolvePersistableCodeEnvironmentDecision({ conversationId: 'conversation-1' })).toEqual(
      {},
    );
  });
});

describe('resolveAdmittedCodeEnvironmentDecision', () => {
  const withMoves = (conversationMoves?: { enabled?: boolean; allowAttachDetach?: boolean }) =>
    ({
      endpoints: { agents: { statefulCodeSessions: { conversationMoves } } },
    }) as AppConfig;

  it.each([undefined, {}, { enabled: false }, { enabled: false, allowAttachDetach: true }])(
    'reuses the loaded decision without a database fence when moves are disabled: %j',
    async (conversationMoves) => {
      const readDecision = jest.fn();
      const conversation = {
        conversationId: 'saved',
        codeEnvironmentMode: 'attached' as const,
        codeWorkspaces: [selection],
      };
      expect(
        await resolveAdmittedCodeEnvironmentDecision({
          appConfig: withMoves(conversationMoves),
          conversationId: 'saved',
          conversation,
          readDecision,
        }),
      ).toEqual({ decision: { mode: 'attached', codeWorkspaces: [selection] }, conversation });
      expect(readDecision).not.toHaveBeenCalled();
    },
  );

  it('does not read or write again without configuration or a persisted conversation', async () => {
    const readDecision = jest.fn();
    expect(
      await resolveAdmittedCodeEnvironmentDecision({
        appConfig: undefined,
        conversationId: 'new-id',
        conversation: null,
        requestedMode: 'without_attached',
        readDecision,
      }),
    ).toEqual({ decision: { mode: 'without_attached' }, conversation: null });
    expect(readDecision).not.toHaveBeenCalled();
  });

  it('uses the authoritative admitted read', async () => {
    const readDecision = jest.fn().mockResolvedValue({
      conversationId: 'saved',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [selection],
    });
    expect(
      await resolveAdmittedCodeEnvironmentDecision({
        appConfig: withMoves({ enabled: true }),
        conversationId: 'saved',
        conversation: { conversationId: 'saved', codeEnvironmentMode: 'without_attached' },
        readDecision,
      }),
    ).toEqual({
      decision: { mode: 'attached', codeWorkspaces: [selection] },
      conversation: {
        conversationId: 'saved',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [selection],
      },
    });
    expect(readDecision).toHaveBeenCalledWith('saved');
  });
  it('carries the authoritative selections rather than a cached machine into validation', async () => {
    const old = { environmentId: 'old', workspaceId: 'repo' };
    const conversation = {
      conversationId: 'saved',
      codeEnvironmentMode: 'attached' as const,
      codeWorkspaces: [old],
    };
    const result = await resolveAdmittedCodeEnvironmentDecision({
      appConfig: withMoves({ enabled: true }),
      conversationId: 'saved',
      conversation,
      readDecision: async () => ({ ...conversation, codeWorkspaces: [selection] }),
    });
    expect(result.conversation?.codeWorkspaces).toEqual([selection]);
    expect(result.decision.codeWorkspaces).toEqual(result.conversation?.codeWorkspaces);
  });

  it('keeps an unpersisted first choice separate from the admitted snapshot', async () => {
    const result = await resolveAdmittedCodeEnvironmentDecision({
      appConfig: withMoves({ enabled: true }),
      conversationId: 'saved',
      conversation: {
        conversationId: 'saved',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [selection],
      },
      requestedMode: 'attached',
      requestedSelections: [selection],
      readDecision: async () => ({ conversationId: 'saved' }),
    });
    expect(result.decision.mode).toBe('attached');
    expect(result.conversation?.codeEnvironmentMode).toBeUndefined();
    expect(result.conversation?.codeWorkspaces).toBeUndefined();
  });

  it('rejects an old requested mode when the transition won first', async () => {
    const readDecision = jest.fn().mockResolvedValue({
      conversationId: 'saved',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [selection],
    });
    await expect(
      resolveAdmittedCodeEnvironmentDecision({
        appConfig: withMoves({ enabled: true, allowAttachDetach: true }),
        conversationId: 'saved',
        requestedMode: 'without_attached',
        readDecision,
      }),
    ).rejects.toMatchObject({ reason: 'locked' });
  });
});
