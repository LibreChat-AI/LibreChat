import { PrincipalType } from 'librechat-data-provider';
import {
  logger,
  SystemCapabilities,
  isBaseConfigPrincipal,
  sortByConfigPrecedence,
  BASE_CONFIG_PRINCIPAL_ID,
} from '@librechat/data-schemas';
import type {
  ConfigRecord,
  ConfigSection,
  AdminConfigLayer,
  SystemCapability,
  ConfigOverrideLayer,
  AdminConfigLayerIgnored,
  AdminResolvedConfigResponse,
  AdminEffectiveConfigResponse,
} from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ResolveConfigLayersOptions, ResolvedConfigLayers } from '~/app/service';
import type { CapabilityUser } from '~/middleware/capabilities';
import type { ServerRequest } from '~/types/http';
import type { ReadableSections } from './config';
import {
  canReadSection,
  getCapabilityUser,
  collectConfigSections,
  validatePrincipalType,
  redactConfigForResponse,
  forbiddenResponse,
  authRequiredResponse,
  principalNotFoundResponse,
  filterSectionsByReadAccess,
  filterConfigDocForReadAccess,
} from './config';
import { getConfigPartition, getActivePartition, runInPartition } from './partition';
import { redactConfigSecrets, redactResolvedConfigSecrets } from './secrets';
import { getSafeErrorMetadata } from '~/utils/errors';

/** A principal a user resolves to, as principal resolution returns it. */
interface ResolvedPrincipal {
  principalType: string;
  principalId?: { toString(): string } | string;
}

export interface AdminConfigReadDeps {
  findConfigByPrincipal: (
    principalType: PrincipalType,
    principalId: string,
    options?: { includeInactive?: boolean },
  ) => Promise<ConfigRecord | null>;
  hasAnyConfigReadAccess: (user: CapabilityUser) => Promise<boolean>;
  getReadableConfigSections: (
    user: CapabilityUser,
    sections: ConfigSection[],
  ) => Promise<{ broad: boolean; sections: Set<string> }>;
  hasCapability: (user: CapabilityUser, capability: SystemCapability) => Promise<boolean>;
  /**
   * Merges documents as the app config service merges a principal's, layer by layer
   * (`createAppConfigService().resolveConfigLayers`). Without it the read routes answer 501.
   */
  resolveConfigLayers?: (options: ResolveConfigLayersOptions) => Promise<ResolvedConfigLayers>;
  /** Whether the principal exists in the caller's tenant partition (`principalExists`). */
  principalExists?: (principalType: PrincipalType, principalId: string) => Promise<boolean>;
  /**
   * A user the caller addresses by id (`findPrincipalUser`), with what principal resolution reads
   * of them and the tenant that holds them: inside a tenant only that tenant's users, outside one
   * any tenant's, as group and user profiles are addressed.
   */
  findPrincipalUser?: (userId: string) => Promise<{
    id: string;
    role?: string;
    idOnTheSource?: string | null;
    tenantId?: string;
  } | null>;
  /** The principals a user resolves to in the active tenant: the user, their role and groups. */
  getUserPrincipals?: (params: {
    userId: string;
    role?: string | null;
    idOnTheSource?: string | null;
  }) => Promise<ResolvedPrincipal[]>;
  /** Base and the principals' active documents, from the active tenant partition. */
  getApplicableConfigs?: (
    principals: Array<{ principalType: string; principalId?: string }>,
  ) => Promise<ConfigRecord[]>;
}

/** A librechat.yaml-shaped tree as an admin read returns it: secrets redacted on a copy. */
function redactYamlTree(
  tree: Partial<TCustomConfig>,
  yamlConfig?: Partial<TCustomConfig>,
): Partial<TCustomConfig> {
  const copy = structuredClone(tree);
  redactConfigSecrets(copy, { previewPlaintext: yamlConfig != null, yamlConfig });
  redactResolvedConfigSecrets(copy);
  return copy;
}

function filterTree(
  tree: Partial<TCustomConfig>,
  readable: ReadableSections,
): Partial<TCustomConfig> {
  return filterSectionsByReadAccess(tree as Record<string, unknown>, (section) =>
    canReadSection(readable, section),
  ) as Partial<TCustomConfig>;
}

/** A document of a resolution as a profile read shows it, with what the merge left out of it. */
function toLayer(
  record: ConfigRecord,
  ignored: readonly AdminConfigLayerIgnored[],
  readable: ReadableSections,
): AdminConfigLayer {
  const shown = redactConfigForResponse(filterConfigDocForReadAccess(record, readable));
  return {
    principalType: shown.principalType,
    principalId: shown.principalId,
    priority: shown.priority,
    isActive: shown.isActive,
    revision: shown.revision,
    overrides: shown.overrides ?? {},
    tombstones: shown.tombstones ?? [],
    ignored: ignored.filter(({ segments }) => canReadSection(readable, segments[0] ?? '')),
  };
}

/**
 * The parts of a resolution every read route returns: librechat.yaml, the documents in merge
 * order (inactive ones too, which the merge skips) and the result, limited to the sections the
 * caller can read and redacted as reads redact.
 */
async function toResolvedBody(
  user: CapabilityUser,
  records: readonly ConfigRecord[],
  resolution: ResolvedConfigLayers,
  getReadableConfigSections: AdminConfigReadDeps['getReadableConfigSections'],
): Promise<Pick<AdminResolvedConfigResponse, 'yaml' | 'layers' | 'resolved'>> {
  const sections = new Set<string>([
    ...Object.keys(resolution.yaml),
    ...Object.keys(resolution.resolved),
    ...records.flatMap(collectConfigSections),
    ...resolution.layers.flatMap(({ ignored }) => ignored.map(({ segments }) => segments[0])),
  ]);
  const readable = await getReadableConfigSections(user, [...sections] as ConfigSection[]);
  const ignoredBy = new Map<ConfigOverrideLayer, AdminConfigLayerIgnored[]>(
    resolution.layers.map(({ layer, ignored }) => [layer, ignored]),
  );
  return {
    yaml: redactYamlTree(filterTree(resolution.yaml, readable)),
    layers: sortByConfigPrecedence(records).map((record) =>
      toLayer(record, ignoredBy.get(record) ?? [], readable),
    ),
    resolved: redactYamlTree(filterTree(resolution.resolved, readable), resolution.yaml),
  };
}

function toPrincipalId(principal: ResolvedPrincipal): string | undefined {
  return principal.principalId?.toString();
}

/**
 * Read-only views of what config documents resolve to, for the admin config API
 * (`resolvedApi`): one profile over Base, or one user over every profile that applies to them.
 * Neither reads or fills the override cache, so a read right after a write shows it.
 */
export function createAdminConfigReadHandlers(deps: AdminConfigReadDeps): {
  getResolvedConfig: (req: ServerRequest, res: Response) => Promise<Response>;
  getEffectiveConfig: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    findConfigByPrincipal,
    hasAnyConfigReadAccess,
    getReadableConfigSections,
    hasCapability,
    resolveConfigLayers,
    principalExists,
    findPrincipalUser,
    getUserPrincipals,
    getApplicableConfigs,
  } = deps;

  /** The Base document of one tenant partition, active or not; none for Base itself. */
  function readBase(isBase: boolean, tenantId: string | undefined): Promise<ConfigRecord | null> {
    if (isBase) {
      return Promise.resolve(null);
    }
    return runInPartition(tenantId, () =>
      findConfigByPrincipal(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID, {
        includeInactive: true,
      }),
    );
  }

  /**
   * GET /resolved/:principalType/:principalId — what a profile resolves to over librechat.yaml
   * and the Base document (Base alone for Base), in librechat.yaml shape, with each document and
   * what the merge does not apply of it. The profile's other principals vary per user and are
   * left out; `GET /effective` resolves a user. A principal with no document resolves to Base,
   * unless it does not exist in the caller's tenant (404 `PRINCIPAL_NOT_FOUND`).
   *
   * It resolves in the partition the profile merges in, as writes judge it (`resolveWriteScope`):
   * the caller's, or for a group or user profile a caller without a tenant reads from a tenant,
   * that tenant's librechat.yaml and Base, read once the document names it.
   */
  async function getResolvedConfig(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };
      if (!validatePrincipalType(principalType)) {
        return res.status(400).json({ error: 'Invalid principalType', code: 'INVALID_PRINCIPAL' });
      }
      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }
      if (!(await hasAnyConfigReadAccess(user))) {
        return forbiddenResponse(res);
      }
      if (!resolveConfigLayers) {
        return res.status(501).json({ error: 'Resolved config is not available' });
      }

      const isBase = isBaseConfigPrincipal({ principalType, principalId });
      const activePartition = getActivePartition();
      const [activeBase, target] = await Promise.all([
        readBase(isBase, activePartition),
        findConfigByPrincipal(principalType, principalId, { includeInactive: true }),
      ]);
      if (
        !target &&
        !isBase &&
        principalExists &&
        !(await principalExists(principalType, principalId))
      ) {
        return principalNotFoundResponse(res);
      }
      const partition = target ? getConfigPartition(target) : activePartition;
      const base = partition === activePartition ? activeBase : await readBase(isBase, partition);
      const records = [base, target].filter((record): record is ConfigRecord => record != null);
      const resolution = await resolveConfigLayers({
        tenantId: partition,
        configs: records.filter((record) => record.isActive),
      });
      const body: AdminResolvedConfigResponse = {
        principalType,
        principalId,
        ...(await toResolvedBody(user, records, resolution, getReadableConfigSections)),
      };
      return res.status(200).json(body);
    } catch (error) {
      logger.error('[adminConfig] getResolvedConfig error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to resolve config' });
    }
  }

  /**
   * GET /effective?userId= — what one user's requests resolve to: Base, then the active profiles
   * of their role, groups and their own, in merge order. Needs `read:users` and `read:groups`
   * besides config read access, since it shows the user's role and group memberships. A user the
   * caller cannot address answers 404 `USER_NOT_FOUND`: inside a tenant, one of another tenant.
   *
   * It resolves in the user's own tenant, as their requests do: their role and groups, that
   * tenant's documents, librechat.yaml as it resolves it. Inside a tenant that is the caller's;
   * a caller without a tenant reads a tenant's user there.
   */
  async function getEffectiveConfig(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const userId = (req.query as Record<string, unknown>).userId;
      if (typeof userId !== 'string' || userId === '') {
        return res.status(400).json({ error: 'userId is required', code: 'INVALID_USER_ID' });
      }
      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }
      const [canReadConfigs, canReadUsers, canReadGroups] = await Promise.all([
        hasAnyConfigReadAccess(user),
        hasCapability(user, SystemCapabilities.READ_USERS),
        hasCapability(user, SystemCapabilities.READ_GROUPS),
      ]);
      if (!canReadConfigs || !canReadUsers || !canReadGroups) {
        return forbiddenResponse(res);
      }
      if (
        !resolveConfigLayers ||
        !findPrincipalUser ||
        !getUserPrincipals ||
        !getApplicableConfigs
      ) {
        return res.status(501).json({ error: 'Effective config is not available' });
      }

      const target = await findPrincipalUser(userId);
      if (!target) {
        return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      }
      const partition = getConfigPartition(target);
      const { named, records } = await runInPartition(partition, async () => {
        const principals = await getUserPrincipals({
          userId: target.id,
          role: target.role ?? null,
          idOnTheSource: target.idOnTheSource ?? null,
        });
        const resolvedNamed = principals.flatMap((principal) => {
          const id = toPrincipalId(principal);
          return id == null
            ? []
            : [{ principalType: principal.principalType as PrincipalType, principalId: id }];
        });
        return { named: resolvedNamed, records: await getApplicableConfigs(resolvedNamed) };
      });
      const resolution = await resolveConfigLayers({ tenantId: partition, configs: records });
      const body: AdminEffectiveConfigResponse = {
        userId: target.id,
        principals: named,
        ...(await toResolvedBody(user, records, resolution, getReadableConfigSections)),
      };
      return res.status(200).json(body);
    } catch (error) {
      logger.error('[adminConfig] getEffectiveConfig error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to resolve effective config' });
    }
  }

  return { getResolvedConfig, getEffectiveConfig };
}
