import { PermissionBits, ResourceType } from 'librechat-data-provider';
import { loadSkillAccess } from './access';

function makeDeps() {
  return {
    findAccessibleResources: jest.fn(
      async ({ requiredPermissions }: { requiredPermissions: number }) =>
        requiredPermissions === PermissionBits.EDIT ? ['edit-1'] : ['view-1'],
    ),
    withDeploymentSkillIds: jest.fn((ids: string[]) => [...ids, 'deployment-1']),
    canCreateSkill: jest.fn(async () => true),
  };
}

describe('loadSkillAccess', () => {
  it('reads nothing while the skills capability is off', async () => {
    const deps = makeDeps();
    const access = await loadSkillAccess({ enabled: false, userId: 'user-1', role: 'USER' }, deps);

    expect(access).toEqual({
      accessibleSkillIds: [],
      editableSkillIds: [],
      skillCreateAllowed: false,
    });
    expect(deps.findAccessibleResources).not.toHaveBeenCalled();
    expect(deps.canCreateSkill).not.toHaveBeenCalled();
  });

  it('starts the view, edit and create reads together', async () => {
    const deps = makeDeps();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.findAccessibleResources.mockImplementationOnce(async () => {
      await gate;
      return ['view-1'];
    });

    const pending = loadSkillAccess({ enabled: true, userId: 'user-1', role: 'USER' }, deps);
    await Promise.resolve();
    expect(deps.findAccessibleResources).toHaveBeenCalledTimes(2);
    expect(deps.canCreateSkill).toHaveBeenCalledTimes(1);
    release();

    expect(await pending).toEqual({
      accessibleSkillIds: ['view-1', 'deployment-1'],
      editableSkillIds: ['edit-1'],
      skillCreateAllowed: true,
    });
    expect(deps.findAccessibleResources).toHaveBeenCalledWith({
      userId: 'user-1',
      role: 'USER',
      resourceType: ResourceType.SKILL,
      requiredPermissions: PermissionBits.VIEW,
    });
  });
});
