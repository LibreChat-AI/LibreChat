import { resolveCodeEnvironmentSelection } from './workspace';

describe('chat machine selection', () => {
  const defaultId = 'application-vm';
  const selections = [{ environmentId: 'runtime-vm', workspaceId: 'primary' }];

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
