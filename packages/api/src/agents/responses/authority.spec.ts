import { tenantStorage } from '@librechat/data-schemas';
import { PermissionBits, Permissions, PermissionTypes } from 'librechat-data-provider';
import type { BackgroundResponseAuthorityDependencies } from './authority';
import { createBackgroundResponseAuthority } from './authority';

const owner = { userId: 'background-owner', tenantId: 'background-tenant' };
function fixture(options: { tenantId?: string | null } = { tenantId: owner.tenantId }) {
  const user = {
    _id: owner.userId,
    role: 'USER',
    tenantId: options.tenantId,
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

it.each([undefined, null, ''])(
  'accepts a legacy tenantless user field %p without changing named authority',
  async (tenantId) => {
    const { deps, authorize } = fixture({ tenantId });
    deps.enrollmentRequired = () => false;
    const principal = { userId: owner.userId };
    expect(await tenantStorage.run(principal, () => authorize(principal, 'agent', 'key'))).toBe(
      true,
    );
    const loaded = await deps.findUser(principal.userId);
    if (!loaded) throw new Error('Fixture missing user');
    jest.mocked(deps.findUser).mockClear();
    expect(await authorize({ ...principal, tenantId: '' }, 'agent', 'key', loaded)).toBe(true);
    expect(deps.findUser).not.toHaveBeenCalled();
    expect(await authorize(owner, 'agent', 'key', loaded)).toBe(false);
  },
);

it.each(['_', '__SYSTEM__'])(
  'rejects internal owner partition %p before principal lookup',
  async (tenantId) => {
    const { deps, authorize } = fixture({ tenantId });
    expect(await authorize({ ...owner, tenantId }, 'agent', 'key')).toBe(false);
    expect(deps.findUser).not.toHaveBeenCalled();
  },
);
