import { Permissions } from 'librechat-data-provider';
import type { IRole } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { canUseProjects, projectsAccessFor, requireProjectsPermission } from './access';

const role = (permissions: Record<string, Record<string, boolean>>) =>
  ({ name: 'USER', permissions }) as unknown as IRole;

describe('canUseProjects', () => {
  it('reads the role and honors a stored refusal', async () => {
    const getRoleByName = jest.fn().mockResolvedValue(role({ PROJECTS: { USE: false } }));

    await expect(
      canUseProjects({ id: 'u', role: 'USER' }, Permissions.USE, { getRoleByName }),
    ).resolves.toBe(false);
    expect(getRoleByName).toHaveBeenCalledWith('USER');
  });

  it('requires USE for CREATE', async () => {
    const getRoleByName = jest
      .fn()
      .mockResolvedValue(role({ PROJECTS: { USE: false, CREATE: true } }));

    await expect(
      canUseProjects({ role: 'USER' }, Permissions.CREATE, { getRoleByName }),
    ).resolves.toBe(false);
  });

  it('allows a role stored before the permission type existed', async () => {
    const getRoleByName = jest.fn().mockResolvedValue(role({ BOOKMARKS: { USE: true } }));

    await expect(
      canUseProjects({ role: 'custom' }, Permissions.CREATE, { getRoleByName }),
    ).resolves.toBe(true);
  });

  it('refuses a user whose role no longer exists', async () => {
    const getRoleByName = jest.fn().mockResolvedValue(null);

    await expect(
      canUseProjects({ role: 'deleted' }, Permissions.USE, { getRoleByName }),
    ).resolves.toBe(false);
  });

  it('refuses a user without a role', async () => {
    const getRoleByName = jest.fn();

    await expect(canUseProjects({ id: 'u' }, Permissions.USE, { getRoleByName })).resolves.toBe(
      false,
    );
    expect(getRoleByName).not.toHaveBeenCalled();
  });
});

describe('projectsAccessFor', () => {
  it('reads the role once per turn', async () => {
    const getRoleByName = jest.fn().mockResolvedValue(role({ PROJECTS: { USE: true } }));
    const check = projectsAccessFor({ role: 'USER' }, { getRoleByName });

    await expect(Promise.all([check(), check()])).resolves.toEqual([true, true]);
    expect(getRoleByName).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed role read instead of caching the failure', async () => {
    const getRoleByName = jest
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(role({ PROJECTS: { USE: true } }));
    const check = projectsAccessFor({ role: 'USER' }, { getRoleByName });

    await expect(check()).rejects.toThrow('unavailable');
    await expect(check()).resolves.toBe(true);
  });
});

describe('requireProjectsPermission', () => {
  const run = async (stored: IRole | Error) => {
    const getRoleByName = jest.fn();
    if (stored instanceof Error) {
      getRoleByName.mockRejectedValue(stored);
    } else {
      getRoleByName.mockResolvedValue(stored);
    }
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) } as unknown as Response;
    const next = jest.fn();
    const req = { user: { id: 'u', role: 'USER' }, method: 'POST', baseUrl: '/api/projects' };
    await requireProjectsPermission(Permissions.CREATE, { getRoleByName })(
      req as unknown as Request,
      res,
      next,
    );
    return { res, json, next };
  };

  it('passes an allowed request through', async () => {
    const { next, res } = await run(role({ PROJECTS: { USE: true, CREATE: true } }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('answers 403 for a refused permission', async () => {
    const { next, res } = await run(role({ PROJECTS: { USE: true, CREATE: false } }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('answers 500 without the error text when the role read fails', async () => {
    const { next, res, json } = await run(new Error('connection string mongodb://secret'));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(json.mock.calls)).not.toContain('secret');
  });
});
