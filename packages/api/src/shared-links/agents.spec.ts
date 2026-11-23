import { PermissionBits, ResourceType } from 'librechat-data-provider';
import { createSharedForkAgentAccess } from './agents';

const viewer = { userId: 'viewer', role: 'USER', tenantId: 'viewer-tenant', idOnTheSource: null };
const allowed = { _id: 'allowed', id: 'agent_allowed' };
const denied = { _id: 'denied', id: 'agent_denied' };
const ids = [allowed.id, denied.id, 'agent_missing', 'ephemeral'];

function setup() {
  const deps = {
    getRoleByName: jest.fn(async () => ({ permissions: { AGENTS: { USE: true } } })),
    getAgents: jest.fn(async () => [allowed, denied]),
    getUserPrincipals: jest.fn(async () => ['viewer-principal']),
    hasCapabilityForPrincipals: jest.fn(async () => false),
    findAccessibleResources: jest.fn(async () => [allowed._id]),
  };
  return { deps, access: createSharedForkAgentAccess(deps) };
}

it('checks only candidate agents, with one scoped principal and VIEW lookup', async () => {
  const { deps, access } = setup();
  await expect(access(viewer, ids)).resolves.toEqual(new Set(['ephemeral', allowed.id]));
  expect(deps.getAgents).toHaveBeenCalledTimes(1);
  expect(deps.getAgents).toHaveBeenCalledWith(
    { id: { $in: [allowed.id, denied.id, 'agent_missing'] } },
    '_id id',
  );
  expect(deps.getUserPrincipals).toHaveBeenCalledWith({
    userId: viewer.userId,
    role: viewer.role,
    idOnTheSource: viewer.idOnTheSource,
  });
  expect(deps.findAccessibleResources).toHaveBeenCalledWith(
    ['viewer-principal'],
    ResourceType.AGENT,
    PermissionBits.VIEW,
    [allowed._id, denied._id],
  );
});

it('honors the viewer tenant manage capability but never selects a missing agent', async () => {
  const { deps, access } = setup();
  deps.hasCapabilityForPrincipals.mockResolvedValue(true);
  await expect(access(viewer, ids)).resolves.toEqual(new Set(['ephemeral', allowed.id, denied.id]));
  expect(deps.hasCapabilityForPrincipals).toHaveBeenCalledWith({
    principals: ['viewer-principal'],
    tenantId: viewer.tenantId,
    capability: 'manage:agents',
  });
});

it('requires AGENTS:USE and skips resource checks for an ephemeral candidate', async () => {
  const { deps, access } = setup();
  deps.getRoleByName.mockResolvedValueOnce({ permissions: { AGENTS: { USE: false } } });
  await expect(access(viewer, ['ephemeral'])).resolves.toEqual(new Set());
  await expect(access(viewer, ['ephemeral'])).resolves.toEqual(new Set(['ephemeral']));
  expect(deps.getAgents).not.toHaveBeenCalled();
  expect(deps.getUserPrincipals).not.toHaveBeenCalled();
  expect(deps.findAccessibleResources).not.toHaveBeenCalled();
});
