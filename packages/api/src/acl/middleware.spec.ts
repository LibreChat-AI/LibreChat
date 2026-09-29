import { Types } from 'mongoose';
import { ResourceType, SystemRoles } from 'librechat-data-provider';
import type { AllMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { AgentPermissionsRequest } from './middleware';
import { createAgentAdminPermissionAccess } from './middleware';

describe('agent admin permission access', () => {
  const resourceId = new Types.ObjectId().toString();
  const setup = (
    role = SystemRoles.ADMIN,
    resourceType = ResourceType.AGENT,
    tenantId?: string,
  ) => {
    const getAgent = jest.fn().mockResolvedValue({ _id: resourceId });
    const fallback = jest.fn();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const req = { params: { resourceType, resourceId }, user: { role, tenantId } };
    const middleware = createAgentAdminPermissionAccess({
      getAgent: getAgent as AllMethods['getAgent'],
      fallback,
    });
    return {
      getAgent,
      fallback,
      next,
      res,
      req,
      run: () => middleware(req as AgentPermissionsRequest, res as unknown as Response, next),
    };
  };

  it.each(['tenant-a', undefined])('scopes the admin lookup to %s', async (tenantId) => {
    const test = setup(SystemRoles.ADMIN, ResourceType.AGENT, tenantId);
    await test.run();
    expect(test.getAgent).toHaveBeenCalledWith(
      { _id: resourceId, tenantId: tenantId ?? { $exists: false } },
      '_id',
    );
    expect(test.next).toHaveBeenCalledTimes(1);
    expect(test.fallback).not.toHaveBeenCalled();
  });

  it('uses the ordinary permission check for non-admins', async () => {
    const test = setup(SystemRoles.USER);
    await test.run();
    expect(test.fallback).toHaveBeenCalled();
    expect(test.getAgent).not.toHaveBeenCalled();
  });

  it('uses the ordinary permission check for other resource types', async () => {
    const test = setup(SystemRoles.ADMIN, ResourceType.PROMPTGROUP);
    await test.run();
    expect(test.fallback).toHaveBeenCalled();
    expect(test.getAgent).not.toHaveBeenCalled();
  });

  it('rejects malformed IDs before looking up an agent', async () => {
    const test = setup();
    test.req.params.resourceId = 'invalid';
    await test.run();
    expect(test.res.status).toHaveBeenCalledWith(404);
    expect(test.getAgent).not.toHaveBeenCalled();
    expect(test.next).not.toHaveBeenCalled();
  });

  it('rejects missing or out-of-tenant agents', async () => {
    const test = setup();
    test.getAgent.mockResolvedValue(null);
    await test.run();
    expect(test.res.status).toHaveBeenCalledWith(404);
    expect(test.next).not.toHaveBeenCalled();
  });

  it('fails closed on lookup errors', async () => {
    const test = setup();
    test.getAgent.mockRejectedValue(new Error('database unavailable'));
    await test.run();
    expect(test.res.status).toHaveBeenCalledWith(500);
    expect(test.next).not.toHaveBeenCalled();
  });
});
