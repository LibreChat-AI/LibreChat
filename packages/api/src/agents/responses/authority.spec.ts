import { tenantStorage } from '@librechat/data-schemas';
import { PermissionBits, Permissions, PermissionTypes } from 'librechat-data-provider';
import type { BackgroundResponseAuthorityDependencies } from './authority';
import { createBackgroundResponseAuthority } from './authority';

const owner = { userId: 'background-owner', tenantId: 'background-tenant' };
function fixture() {
  const user = {
    _id: owner.userId,
    role: 'USER',
    tenantId: owner.tenantId,
    provider: 'local',
    twoFactorEnabled: false,
  };
  const deps: BackgroundResponseAuthorityDependencies = {
    findUser: jest.fn().mockResolvedValue(user),
    getKey: jest.fn().mockResolvedValue({}),
    getRole: jest.fn().mockResolvedValue({
      permissions: { [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true } },
    }),
    getConfig: jest.fn().mockResolvedValue({
      endpoints: {
        agents: {
          remoteApi: { background: { enabled: true }, auth: { apiKey: { enabled: true } } },
        },
      },
    }),
    getAgentPermissions: jest.fn().mockResolvedValue(PermissionBits.VIEW),
    isPrincipalActive: jest.fn().mockResolvedValue(true),
  };
  return { deps, user, authorize: createBackgroundResponseAuthority(deps) };
}
const originalPolicy = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
afterEach(() => {
  if (originalPolicy === undefined) delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
  else process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = originalPolicy;
});

it('rechecks shared enrollment policy when enforcement changes after queue admission', async () => {
  const { user, deps, authorize } = fixture();
  process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
  expect(await authorize(owner, 'agent', 'original-key')).toBe(true);
  process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
  jest.mocked(deps.getKey).mockClear();
  expect(await authorize(owner, 'agent', 'original-key')).toBe(false);
  expect(deps.getKey).not.toHaveBeenCalled();
  user.twoFactorEnabled = true;
  expect(await authorize(owner, 'agent', 'original-key')).toBe(true);
});

it('uses an already-loaded user while enforcing enrollment before background grants', async () => {
  const { deps, authorize } = fixture();
  process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
  const user = await deps.findUser(owner.userId);
  if (!user) throw new Error('Fixture missing user');
  jest.mocked(deps.findUser).mockClear();
  expect(
    await tenantStorage.run(owner, () => authorize(owner, 'agent', 'original-key', user)),
  ).toBe(false);
  expect(deps.findUser).not.toHaveBeenCalled();
  expect(deps.getKey).not.toHaveBeenCalled();
});

it('accepts the host enrollment policy dependency without bypassing it for a loaded user', async () => {
  const { deps } = fixture();
  deps.enrollmentRequired = jest.fn().mockReturnValue(true);
  const user = await deps.findUser(owner.userId);
  if (!user) throw new Error('Fixture missing user');
  expect(await createBackgroundResponseAuthority(deps)(owner, 'agent', 'original-key', user)).toBe(
    false,
  );
  expect(deps.enrollmentRequired).toHaveBeenCalledWith(user);
  expect(deps.getKey).not.toHaveBeenCalled();
});

it('preserves federated policy exceptions and tenant isolation', async () => {
  const { user, authorize } = fixture();
  process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
  user.provider = 'openid';
  expect(await authorize(owner, 'agent', 'original-key')).toBe(true);
  expect(
    await tenantStorage.run({ tenantId: 'other-tenant' }, () =>
      authorize(owner, 'agent', 'original-key'),
    ),
  ).toBe(false);
});
