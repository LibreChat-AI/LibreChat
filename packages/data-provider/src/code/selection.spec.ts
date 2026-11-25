import {
  resolveCodeEnvironmentSelection,
  isCodeWorkspaceSelection,
  canonicalizeCodeWorkspaceSelections,
} from './workspace';
import { EModelEndpoint, tConvoUpdateSchema } from '../schemas';
import { appendAgentIdSuffix } from '../agents/identity';
import createPayload from '../createPayload';

describe('chat machine selection', () => {
  it.each(['source', 'isolated'] as const)(
    'validates and retains the %s checkout in the sealed identity',
    (checkout) => {
      const selection = { environmentId: 'vm', workspaceId: 'repo', checkout };
      expect(isCodeWorkspaceSelection(selection)).toBe(true);
      expect(canonicalizeCodeWorkspaceSelections([selection])).toEqual([selection]);
      const conversation = {
        conversationId: null,
        endpoint: EModelEndpoint.agents,
        endpointType: null,
        codeWorkspaces: [selection],
      };
      expect(tConvoUpdateSchema.parse(conversation).codeWorkspaces).toEqual([selection]);
      expect(
        createPayload({
          conversation,
          endpointOption: { endpoint: EModelEndpoint.agents },
          userMessage: { text: 'hello' },
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [selection],
        } as Parameters<typeof createPayload>[0]).payload.codeWorkspaces,
      ).toEqual([selection]);
    },
  );

  it.each([null, 'automatic', 'invalid', {}, 1])('rejects an invalid checkout: %j', (checkout) => {
    expect(isCodeWorkspaceSelection({ environmentId: 'vm', workspaceId: 'repo', checkout })).toBe(
      false,
    );
  });

  const defaultId = 'application-vm';
  const selections = [{ environmentId: 'runtime-vm', workspaceId: 'primary' }];

  it.each([0, 1, 2])('matches stable ownership for parallel runtime index %s', (index) => {
    expect(
      resolveCodeEnvironmentSelection({
        agentId: appendAgentIdSuffix('primary', index),
        environmentId: defaultId,
        environmentIds: ['runtime-vm'],
        allowSelection: true,
        selections: [
          { environmentId: defaultId, workspaceId: 'primary' },
          { ...selections[0], agentIds: ['primary'] },
        ],
      }),
    ).toEqual({ valid: true, environmentId: 'runtime-vm' });
  });

  it.each([
    { allowSelection: false, environmentIds: ['runtime-vm'] },
    { allowSelection: true, environmentIds: [] },
    { allowSelection: false, environmentIds: [] },
  ])('refuses a revoked owned alternative instead of falling back: %j', (gate) => {
    expect(
      resolveCodeEnvironmentSelection({
        ...gate,
        agentId: 'primary',
        environmentId: defaultId,
        selections: [
          { environmentId: defaultId, workspaceId: 'primary' },
          { ...selections[0], agentIds: ['primary'] },
        ],
      }),
    ).toEqual({ valid: false });
  });

  it("does not inherit another agent's explicitly owned alternative", () => {
    expect(
      resolveCodeEnvironmentSelection({
        agentId: 'primary',
        environmentId: defaultId,
        environmentIds: ['runtime-vm'],
        allowSelection: true,
        selections: [{ ...selections[0], agentIds: ['other'] }],
      }),
    ).toEqual({ valid: false });
  });

  it('keeps an explicitly owned default after machine selection is disabled', () => {
    expect(
      resolveCodeEnvironmentSelection({
        agentId: appendAgentIdSuffix('primary', 1),
        environmentId: defaultId,
        allowSelection: false,
        selections: [{ environmentId: defaultId, workspaceId: 'primary', agentIds: ['primary'] }],
      }),
    ).toEqual({ valid: true, environmentId: defaultId });
  });

  it('routes the selectable primary to B while its fixed reviewer keeps A', () => {
    const graph = [
      { environmentId: defaultId, workspaceId: 'primary' },
      { ...selections[0], agentIds: ['primary'] },
    ];
    expect(
      resolveCodeEnvironmentSelection({
        agentId: 'primary',
        environmentId: defaultId,
        environmentIds: ['runtime-vm'],
        allowSelection: true,
        selections: graph,
      }),
    ).toEqual({ valid: true, environmentId: 'runtime-vm' });
    expect(
      resolveCodeEnvironmentSelection({
        agentId: 'reviewer',
        environmentId: defaultId,
        selections: graph,
      }),
    ).toEqual({ valid: true, environmentId: defaultId });
  });

  it('rejects an explicitly owned choice outside the agent allowlist rather than falling back', () => {
    expect(
      resolveCodeEnvironmentSelection({
        agentId: 'primary',
        environmentId: defaultId,
        environmentIds: ['runtime-vm'],
        allowSelection: true,
        selections: [
          { environmentId: defaultId, workspaceId: 'primary' },
          { environmentId: 'foreign', workspaceId: 'primary', agentIds: ['primary'] },
        ],
      }),
    ).toEqual({ valid: false });
  });

  it('retains the agent default without an opt-in or a chat choice', () => {
    expect(resolveCodeEnvironmentSelection({ environmentId: defaultId, selections })).toEqual({
      valid: true,
      environmentId: defaultId,
    });
    expect(
      resolveCodeEnvironmentSelection({ environmentId: defaultId, allowSelection: true }),
    ).toEqual({
      valid: true,
      environmentId: defaultId,
    });
  });

  it('uses the chat choice without mutating the agent or the selection', () => {
    const frozen = Object.freeze(selections.map((selection) => Object.freeze({ ...selection })));
    expect(
      resolveCodeEnvironmentSelection({
        environmentId: defaultId,
        allowSelection: true,
        selections: frozen,
        environmentIds: ['runtime-vm'],
      }),
    ).toEqual({
      valid: true,
      environmentId: 'runtime-vm',
    });
  });

  it.each(
    [
      [{ environmentId: 'runtime-vm', workspaceId: '' }],
      [...selections, ...selections],
      { environmentId: 'runtime-vm' },
    ].map((invalid) => ({ invalid })),
  )('rejects malformed or ambiguous choices', ({ invalid }) => {
    expect(
      resolveCodeEnvironmentSelection({
        environmentId: defaultId,
        allowSelection: true,
        selections: invalid,
        environmentIds: ['runtime-vm'],
      }),
    ).toEqual({ valid: false });
  });

  it('preserves the selected default when another graph agent needs an allowed alternative', () => {
    expect(
      resolveCodeEnvironmentSelection({
        environmentId: defaultId,
        environmentIds: ['runtime-vm'],
        allowSelection: true,
        selections: [...selections, { environmentId: defaultId, workspaceId: 'primary' }],
      }),
    ).toEqual({ valid: true, environmentId: defaultId });
  });

  it('rejects multiple allowed non-default machines without guessing', () => {
    expect(
      resolveCodeEnvironmentSelection({
        environmentId: defaultId,
        environmentIds: ['runtime-vm', 'another-vm'],
        allowSelection: true,
        selections: [...selections, { environmentId: 'another-vm', workspaceId: 'primary' }],
      }),
    ).toEqual({ valid: false });
  });

  it('rejects a machine omitted from the agent allowlist', () => {
    expect(
      resolveCodeEnvironmentSelection({
        environmentId: defaultId,
        environmentIds: ['another-vm'],
        allowSelection: true,
        selections,
      }),
    ).toEqual({ valid: false });
  });

  it('resolves each agent independently in a graph with disjoint machine lists', () => {
    const graph = [...selections, { environmentId: 'another-vm', workspaceId: 'repo' }];
    expect(
      resolveCodeEnvironmentSelection({
        environmentId: defaultId,
        environmentIds: ['runtime-vm'],
        allowSelection: true,
        selections: graph,
      }),
    ).toEqual({ valid: true, environmentId: 'runtime-vm' });
    expect(
      resolveCodeEnvironmentSelection({
        environmentId: 'another-vm',
        environmentIds: ['yet-another-vm'],
        allowSelection: true,
        selections: graph,
      }),
    ).toEqual({ valid: true, environmentId: 'another-vm' });
  });
});
