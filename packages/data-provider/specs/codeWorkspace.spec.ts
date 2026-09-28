import {
  isCodeEnvironmentMode,
  isCodeWorkspaceSelection,
  isCodeWorkspaceSelections,
} from '../src/code/workspace';

describe('isCodeEnvironmentMode', () => {
  it.each(['attached', 'without_attached'])('accepts %s', (mode) => {
    expect(isCodeEnvironmentMode(mode)).toBe(true);
  });

  it.each(['managed', 'none', '', null])('rejects %p', (mode) => {
    expect(isCodeEnvironmentMode(mode)).toBe(false);
  });
});

describe('isCodeWorkspaceSelection', () => {
  it('accepts an exact environment/workspace binding', () => {
    expect(
      isCodeWorkspaceSelection({ environmentId: 'personal-vm', workspaceId: 'project:a' }),
    ).toBe(true);
  });

  it.each([
    { environmentId: 1, workspaceId: 'project-a' },
    { environmentId: 'personal-vm', workspaceId: 1 },
    { environmentId: 'personal-vm', workspaceId: '../escape' },
    { environmentId: 'personal-vm', workspaceId: 'project-a', operations: ['execute_command'] },
  ])('rejects a malformed or capability-bearing binding: %p', (selection) => {
    expect(isCodeWorkspaceSelection(selection)).toBe(false);
  });
});

describe('isCodeWorkspaceSelections', () => {
  it('accepts one exact binding per environment', () => {
    expect(
      isCodeWorkspaceSelections([
        { environmentId: 'personal-vm', workspaceId: 'project-a' },
        { environmentId: 'team-vm', workspaceId: 'project-b' },
      ]),
    ).toBe(true);
  });

  it('rejects duplicate environment bindings', () => {
    expect(
      isCodeWorkspaceSelections([
        { environmentId: 'personal-vm', workspaceId: 'project-a' },
        { environmentId: 'personal-vm', workspaceId: 'project-b' },
      ]),
    ).toBe(false);
  });
});
