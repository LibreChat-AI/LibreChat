import { runAsSystem, tenantStorage } from '@librechat/data-schemas';
import { normalizeBrowserEnrollmentInstance } from '@librechat/code/browser-enrollment';
import type { AppConfig, BrowserSetupSession, BrowserSetupUser } from '@librechat/data-schemas';
import type { GetAppConfigOptions } from '~/app/service';
import { resolveCodeWorkerEnrollmentLimit } from '../enrollment';
import { isTwoFactorEnrollmentRequired } from '~/auth/twoFactor';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { getCodeApiTenantIdForUser } from '~/auth/codeapi';
import { isEnabled } from '~/utils/common';

export type SetupUser = BrowserSetupUser;
type Sessions = NonNullable<NonNullable<AppConfig['endpoints']>['agents']>['statefulCodeSessions'];
export type SetupPlane = NonNullable<NonNullable<Sessions>['environments']>[number];
export type SetupConfig = NonNullable<
  NonNullable<NonNullable<Sessions>['principalWorkers']>['browserSetup']
>;
export type ExistingSetupPolicy = {
  config: Pick<SetupConfig, 'instance' | 'retentionMs'>;
  planes: SetupPlane[];
  maxOwned: number;
  user?: SetupUser;
  tenantId?: string;
  codeTenantId?: string;
};
export type SetupPolicy = ExistingSetupPolicy & { config: SetupConfig };

export class SetupPolicyError extends Error {
  constructor(
    public readonly code: 'SETUP_UNAVAILABLE' | 'ACCOUNT_UNAVAILABLE' | 'POLICY_WITHDRAWN',
  ) {
    super(code);
  }
}
export interface SetupPolicyDependencies {
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  getUser: (id: string) => Promise<SetupUser | null>;
  userIsBanned: (id: string) => Promise<boolean>;
  principalAuthEnabled: () => boolean;
  principalAuthReady: () => Promise<void> | void;
}
function sessions(config: AppConfig): Sessions {
  return config.endpoints?.agents?.statefulCodeSessions;
}
function planes(config: AppConfig, existing = false): SetupPlane[] {
  return (
    sessions(config)?.environments?.filter(
      (plane) =>
        plane.type === 'attached' &&
        plane.owner === 'deployment' &&
        plane.pairing?.tokenEnv != null &&
        (existing || plane.pairing.allowPrincipalWorkers === true),
    ) ?? []
  );
}
export function readSetupConfig(config: AppConfig, requireEnabled = true): SetupConfig {
  const settings = sessions(config)?.principalWorkers?.browserSetup;
  if (
    settings == null ||
    (requireEnabled && settings.enabled !== true) ||
    normalizeBrowserEnrollmentInstance(settings.instance) !== settings.instance
  ) {
    throw new SetupPolicyError('SETUP_UNAVAILABLE');
  }
  return settings;
}

/** Identity and authorization are reloaded independently of browser middleware. */
export function createSetupPolicy(deps: SetupPolicyDependencies): {
  deployment: (options?: { existing?: boolean }) => Promise<SetupPolicy>;
  user: (id: string, expectedTenantId?: string) => Promise<SetupPolicy>;
  frozen: (
    session: BrowserSetupSession,
    options?: { completed?: boolean },
  ) => Promise<ExistingSetupPolicy>;
} {
  async function deployment(options: { existing?: boolean } = {}): Promise<SetupPolicy> {
    if (!deps.principalAuthEnabled()) throw new SetupPolicyError('SETUP_UNAVAILABLE');
    const [base] = await Promise.all([
      deps.getAppConfig({ baseOnly: true, failClosed: true, refresh: true }),
      deps.principalAuthReady(),
    ]);
    const config = readSetupConfig(base, !options.existing);
    const maxOwned = resolveCodeWorkerEnrollmentLimit(sessions(base)?.principalWorkers);
    const authorized = planes(base, options.existing);
    if (!options.existing && (maxOwned === 0 || authorized.length === 0))
      throw new SetupPolicyError('SETUP_UNAVAILABLE');
    return { config, planes: authorized, maxOwned };
  }
  async function account(id: string, expectedTenantId?: string): Promise<SetupUser> {
    const [user, banned] = await Promise.all([
      runAsSystem(async () => deps.getUser(id)),
      deps.userIsBanned(id),
    ]);
    if (
      user == null ||
      user.id !== id ||
      user.agentTriggerDeletionStartedAt != null ||
      banned ||
      (user.expiresAt != null && user.expiresAt.getTime() <= Date.now()) ||
      isTwoFactorEnrollmentRequired(user) ||
      (user.provider === 'local' &&
        user.emailVerified !== true &&
        !isEnabled(process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN)) ||
      (expectedTenantId != null && (user.tenantId ?? '') !== expectedTenantId)
    ) {
      throw new SetupPolicyError('ACCOUNT_UNAVAILABLE');
    }
    return user;
  }
  function assertTerms(config: AppConfig, user: SetupUser): void {
    if (
      config.interfaceConfig?.termsOfService?.modalAcceptance === true &&
      user.termsAccepted !== true
    ) {
      throw new SetupPolicyError('POLICY_WITHDRAWN');
    }
  }
  async function user(id: string, expectedTenantId?: string): Promise<SetupPolicy> {
    const owner = await account(id, expectedTenantId);
    return await tenantStorage.run({ tenantId: owner.tenantId, userId: id }, async () => {
      const [base, effective] = await Promise.all([
        deployment(),
        deps.getAppConfig({
          ...getAppConfigOptionsFromUser(owner),
          refresh: true,
          failClosed: true,
          skipRuntimeAugmentation: true,
        }),
      ]);
      assertTerms(effective, owner);
      const settings = sessions(effective)?.principalWorkers;
      const maxOwned = resolveCodeWorkerEnrollmentLimit({ maxPerUser: base.maxOwned }, settings);
      const allowed = new Set(planes(effective).map((plane) => plane.id));
      const authorized = base.planes.filter((plane) => allowed.has(plane.id));
      if (settings?.browserSetup?.enabled === false || maxOwned === 0 || authorized.length === 0)
        throw new SetupPolicyError('POLICY_WITHDRAWN');
      return {
        ...base,
        user: owner,
        maxOwned,
        planes: authorized,
        tenantId: owner.tenantId ?? '',
        codeTenantId: getCodeApiTenantIdForUser(owner),
      };
    });
  }
  async function existing(session: BrowserSetupSession): Promise<ExistingSetupPolicy> {
    const owner = await account(session.ownerId!, session.tenantId);
    if (!deps.principalAuthEnabled()) throw new SetupPolicyError('POLICY_WITHDRAWN');
    return await tenantStorage.run({ tenantId: owner.tenantId, userId: owner.id }, async () => {
      const [base, effective] = await Promise.all([
        deps.getAppConfig({ baseOnly: true, refresh: true, failClosed: true }),
        deps.getAppConfig({
          ...getAppConfigOptionsFromUser(owner),
          refresh: true,
          failClosed: true,
          skipRuntimeAugmentation: true,
        }),
        deps.principalAuthReady(),
      ]);
      assertTerms(effective, owner);
      const allowed = new Set(planes(effective, true).map((plane) => plane.id));
      const authorized = planes(base, true).filter((plane) => allowed.has(plane.id));
      const settings = sessions(base)?.principalWorkers?.browserSetup;
      // Enrollment toggles and capacity govern new trust, not an existing redeemed identity.
      return {
        config: {
          instance: settings?.instance ?? session.approval!.instance,
          retentionMs: settings?.retentionMs ?? 86_400_000,
        },
        planes: authorized,
        maxOwned: 0,
        user: owner,
        tenantId: owner.tenantId ?? '',
        codeTenantId: getCodeApiTenantIdForUser(owner),
      };
    });
  }
  async function frozen(
    session: BrowserSetupSession,
    options: { completed?: boolean } = {},
  ): Promise<ExistingSetupPolicy> {
    if (session.ownerId == null || session.approval == null)
      throw new SetupPolicyError('POLICY_WITHDRAWN');
    const resolved = options.completed
      ? await existing(session)
      : await user(session.ownerId, session.tenantId);
    const plane = resolved.planes.find(({ id }) => id === session.planeId);
    if (
      plane == null ||
      plane.baseURL.replace(/\/+$/, '') !== session.baseURL ||
      plane.pairing?.tokenEnv !== session.tokenEnv ||
      resolved.codeTenantId !== session.approval.binding.tenantId ||
      resolved.config.instance !== session.approval.instance
    )
      throw new SetupPolicyError('POLICY_WITHDRAWN');
    return resolved;
  }
  return { deployment, user, frozen };
}
export type SetupPolicyReader = ReturnType<typeof createSetupPolicy>;
