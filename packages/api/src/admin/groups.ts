import { Types } from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import { logger, isValidObjectIdString } from '@librechat/data-schemas';
import type {
  IGroup,
  IUser,
  ConfigRecord,
  CreateGroupRequest,
  UpdateGroupRequest,
  GroupFilterOptions,
} from '@librechat/data-schemas';
import type { FilterQuery, ClientSession, DeleteResult } from 'mongoose';
import type { Response } from 'express';
import type { ValidationError } from '~/types/error';
import type { ServerRequest } from '~/types/http';
import type { RecordAuditEntry } from './audit';
import { cascadeStep, runCascade, invalidatingConfigStore } from './cascade';
import { getSafeErrorMetadata } from '~/utils/errors';
import { createAdminAuditEmitter } from './audit';
import { parsePagination } from './pagination';

type GroupListFilter = Pick<GroupFilterOptions, 'source' | 'search'>;

const VALID_GROUP_SOURCES: ReadonlySet<string> = new Set(['local', 'entra']);
const MAX_CREATE_MEMBER_IDS = 500;
/** Member ids per audit entry, so group creation writes a few ordered entries. */
const AUDIT_MEMBER_CHUNK = 100;
const MAX_SEARCH_LENGTH = 200;
const MAX_NAME_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_EMAIL_LENGTH = 500;
const MAX_AVATAR_LENGTH = 2000;
const MAX_EXTERNAL_ID_LENGTH = 500;

interface GroupIdParams {
  id: string;
}

interface GroupMemberParams extends GroupIdParams {
  userId: string;
}

export interface AdminGroupsDeps {
  listGroups: (
    filter?: GroupListFilter & { limit?: number; offset?: number },
    session?: ClientSession,
  ) => Promise<IGroup[]>;
  countGroups: (filter?: GroupListFilter, session?: ClientSession) => Promise<number>;
  findGroupById: (
    groupId: string | Types.ObjectId,
    projection?: Record<string, 0 | 1>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  createGroup: (groupData: Partial<IGroup>, session?: ClientSession) => Promise<IGroup>;
  /** Sets the fields and reports, from the write itself, whether any value changed. */
  updateGroupFieldsTracked: (
    groupId: string | Types.ObjectId,
    data: Partial<Pick<IGroup, 'name' | 'description' | 'email' | 'avatar'>>,
  ) => Promise<{ group: IGroup; changed: boolean; changedFields: string[] } | null>;
  deleteGroup: (
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  /** `changed` is decided by the write itself: true only when the membership was altered. */
  addUserToGroup: (
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<{ user: IUser; group: IGroup | null; changed: boolean }>;
  removeUserFromGroup: (
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<{ user: IUser; group: IGroup | null; changed: boolean }>;
  removeMemberByIdTracked: (
    groupId: string | Types.ObjectId,
    memberId: string,
    session?: ClientSession,
  ) => Promise<{ group: IGroup | null; changed: boolean }>;
  findUsers: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
  ) => Promise<IUser[]>;
  deleteConfig: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
  ) => Promise<ConfigRecord | null>;
  deleteAclEntries: (filter: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
  }) => Promise<DeleteResult>;
  /** Re-creates a removed config override in full, only if none exists, when the group
   * deletion cannot finish. ACL entries are never restored. Resolves to whether it inserted. */
  restoreConfig?: (snapshot: ConfigRecord) => Promise<boolean>;
  /** Reads the override before it is removed, so a rejected removal whose commit was
   * lost in transit can still be put back. */
  findConfigByPrincipal?: (
    principalType: PrincipalType,
    principalId: string,
    options?: { includeInactive?: boolean },
  ) => Promise<ConfigRecord | null>;
  /** Clears the merged-config caches (on every instance, with Redis) after the deletion removes
   * or restores the group's config override, before the response, as config writes do. */
  invalidateConfigCaches?: (tenantId?: string) => Promise<void>;
  /** Optional audit emission for group mutations; fail-open unless `auditFailClosed`. */
  recordAuditEntry?: RecordAuditEntry;
  /** When true, a failed audit write surfaces as a 5xx after the mutation has
   * been persisted. Defaults to fail-open. */
  auditFailClosed?: boolean;
}

function groupTarget(group: Pick<IGroup, 'name'> & { _id?: unknown }, id?: string) {
  return { type: 'group', id: id ?? String(group._id ?? ''), name: group.name };
}

export function createAdminGroupsHandlers(deps: AdminGroupsDeps): {
  listGroups: (req: ServerRequest, res: Response) => Promise<Response>;
  getGroup: (req: ServerRequest, res: Response) => Promise<Response>;
  createGroup: (req: ServerRequest, res: Response) => Promise<Response>;
  updateGroup: (req: ServerRequest, res: Response) => Promise<Response>;
  deleteGroup: (req: ServerRequest, res: Response) => Promise<Response>;
  getGroupMembers: (req: ServerRequest, res: Response) => Promise<Response>;
  addGroupMember: (req: ServerRequest, res: Response) => Promise<Response>;
  removeGroupMember: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    listGroups,
    countGroups,
    findGroupById,
    createGroup,
    updateGroupFieldsTracked,
    deleteGroup,
    addUserToGroup,
    removeUserFromGroup,
    removeMemberByIdTracked,
    findUsers,
    deleteConfig,
    deleteAclEntries,
    restoreConfig,
    findConfigByPrincipal,
    invalidateConfigCaches,
    recordAuditEntry,
    auditFailClosed,
  } = deps;

  const emitRevocationAudit = createAdminAuditEmitter({
    recordAuditEntry,
    logPrefix: '[adminGroups]',
  });
  const emitAudit = createAdminAuditEmitter({
    recordAuditEntry,
    failClosed: auditFailClosed,
    logPrefix: '[adminGroups]',
  });

  async function listGroupsHandler(req: ServerRequest, res: Response) {
    try {
      const { search, source } = req.query as { search?: string; source?: string };
      const filter: GroupListFilter = {};
      if (source && VALID_GROUP_SOURCES.has(source)) {
        filter.source = source as IGroup['source'];
      }
      if (search && search.length > MAX_SEARCH_LENGTH) {
        return res
          .status(400)
          .json({ error: `search must not exceed ${MAX_SEARCH_LENGTH} characters` });
      }
      if (search) {
        filter.search = search;
      }
      const { limit, offset } = parsePagination(req.query);
      const [groups, total] = await Promise.all([
        listGroups({ ...filter, limit, offset }),
        countGroups(filter),
      ]);
      return res.status(200).json({ groups, total, limit, offset });
    } catch (error) {
      logger.error('[adminGroups] listGroups error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to list groups' });
    }
  }

  async function getGroupHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as GroupIdParams;
      if (!isValidObjectIdString(id)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }
      const group = await findGroupById(id);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      return res.status(200).json({ group });
    } catch (error) {
      logger.error('[adminGroups] getGroup error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to get group' });
    }
  }

  async function createGroupHandler(req: ServerRequest, res: Response) {
    try {
      const body = req.body as CreateGroupRequest;
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      if (body.name.trim().length > MAX_NAME_LENGTH) {
        return res
          .status(400)
          .json({ error: `name must not exceed ${MAX_NAME_LENGTH} characters` });
      }
      if (body.source && !VALID_GROUP_SOURCES.has(body.source)) {
        return res.status(400).json({ error: 'Invalid source value' });
      }
      if (body.description && body.description.length > MAX_DESCRIPTION_LENGTH) {
        return res
          .status(400)
          .json({ error: `description must not exceed ${MAX_DESCRIPTION_LENGTH} characters` });
      }
      if (body.email && body.email.length > MAX_EMAIL_LENGTH) {
        return res
          .status(400)
          .json({ error: `email must not exceed ${MAX_EMAIL_LENGTH} characters` });
      }
      if (body.avatar && body.avatar.length > MAX_AVATAR_LENGTH) {
        return res
          .status(400)
          .json({ error: `avatar must not exceed ${MAX_AVATAR_LENGTH} characters` });
      }
      if (body.idOnTheSource && body.idOnTheSource.length > MAX_EXTERNAL_ID_LENGTH) {
        return res
          .status(400)
          .json({ error: `idOnTheSource must not exceed ${MAX_EXTERNAL_ID_LENGTH} characters` });
      }

      const rawIds = Array.isArray(body.memberIds) ? body.memberIds : [];
      if (rawIds.length > MAX_CREATE_MEMBER_IDS) {
        return res
          .status(400)
          .json({ error: `memberIds must not exceed ${MAX_CREATE_MEMBER_IDS} entries` });
      }
      let memberIds = rawIds;
      const objectIds = rawIds.filter(isValidObjectIdString);
      if (objectIds.length > 0) {
        const users = await findUsers({ _id: { $in: objectIds } }, 'idOnTheSource');
        const idMap = new Map<string, string>();
        for (const user of users) {
          const uid = user._id?.toString() ?? '';
          idMap.set(uid, user.idOnTheSource || uid);
        }
        const unmapped = objectIds.filter((oid) => !idMap.has(oid));
        if (unmapped.length > 0) {
          logger.warn(
            '[adminGroups] createGroup: memberIds contain unknown user ObjectIds:',
            unmapped,
          );
        }
        memberIds = rawIds.map((id) => idMap.get(id) || id);
      }

      const group = await createGroup({
        name: body.name.trim(),
        description: body.description,
        email: body.email,
        avatar: body.avatar,
        source: body.source || 'local',
        memberIds,
        ...(body.idOnTheSource ? { idOnTheSource: body.idOnTheSource } : {}),
      });
      await emitAudit(req, {
        action: 'group.created',
        target: groupTarget(group),
        metadata: { source: group.source ?? null, memberCount: memberIds.length },
      });
      /** The initial members gain group-scoped access, so each is recorded like a member add
       * (bounded by MAX_CREATE_MEMBER_IDS; sequential to keep the audit chain ordered). */
      const unique = [...new Set(memberIds)];
      for (let i = 0; i < unique.length; i += AUDIT_MEMBER_CHUNK) {
        const chunk = unique.slice(i, i + AUDIT_MEMBER_CHUNK);
        await emitAudit(req, {
          action: 'group.member_added',
          severity: 'warning',
          target: groupTarget(group),
          metadata: { userIds: chunk.join(','), count: chunk.length },
        });
      }
      return res.status(201).json({ group });
    } catch (error) {
      if ((error as ValidationError).name === 'ValidationError') {
        return res.status(400).json({ error: (error as ValidationError).message });
      }
      logger.error('[adminGroups] createGroup error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to create group' });
    }
  }

  async function updateGroupHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as GroupIdParams;
      if (!isValidObjectIdString(id)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }
      const body = req.body as UpdateGroupRequest;

      if (
        body.name !== undefined &&
        (!body.name || typeof body.name !== 'string' || !body.name.trim())
      ) {
        return res.status(400).json({ error: 'name must be a non-empty string' });
      }
      if (body.name !== undefined && body.name.trim().length > MAX_NAME_LENGTH) {
        return res
          .status(400)
          .json({ error: `name must not exceed ${MAX_NAME_LENGTH} characters` });
      }
      if (body.description !== undefined && body.description.length > MAX_DESCRIPTION_LENGTH) {
        return res
          .status(400)
          .json({ error: `description must not exceed ${MAX_DESCRIPTION_LENGTH} characters` });
      }
      if (body.email !== undefined && body.email.length > MAX_EMAIL_LENGTH) {
        return res
          .status(400)
          .json({ error: `email must not exceed ${MAX_EMAIL_LENGTH} characters` });
      }
      if (body.avatar !== undefined && body.avatar.length > MAX_AVATAR_LENGTH) {
        return res
          .status(400)
          .json({ error: `avatar must not exceed ${MAX_AVATAR_LENGTH} characters` });
      }

      const updateData: Partial<Pick<IGroup, 'name' | 'description' | 'email' | 'avatar'>> = {};
      if (body.name !== undefined) {
        updateData.name = body.name.trim();
      }
      if (body.description !== undefined) {
        updateData.description = body.description;
      }
      if (body.email !== undefined) {
        updateData.email = body.email;
      }
      if (body.avatar !== undefined) {
        updateData.avatar = body.avatar;
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      /** The write itself reports whether it changed a value, so overlapping identical
       * requests record one entry. */
      const result = await updateGroupFieldsTracked(id, updateData);
      if (!result) {
        return res.status(404).json({ error: 'Group not found' });
      }
      const { group, changed, changedFields } = result;
      if (changed) {
        await emitAudit(req, {
          action: 'group.updated',
          target: groupTarget(group, id),
          metadata: { fields: [...changedFields].sort().join(',') },
        });
      }
      return res.status(200).json({ group });
    } catch (error) {
      if ((error as ValidationError).name === 'ValidationError') {
        return res.status(400).json({ error: (error as ValidationError).message });
      }
      logger.error('[adminGroups] updateGroup error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to update group' });
    }
  }

  async function deleteGroupHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as GroupIdParams;
      if (!isValidObjectIdString(id)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }
      const existing = await findGroupById(id);
      if (!existing) {
        return res.status(404).json({ error: 'Group not found' });
      }
      const target = groupTarget(existing, id);
      const { deleteConfig: removeProfile, restoreConfig: restoreProfile } =
        invalidatingConfigStore(
          { deleteConfig, restoreConfig },
          { invalidateConfigCaches, tenantId: req.user?.tenantId, logPrefix: '[adminGroups]' },
        );
      /**
       * The attempt is recorded as `pending` before any removal so a crash mid-cascade
       * still leaves a trail, but the write is started without being awaited: deleting a
       * group revokes access, so audit latency must not delay the cleanup. Every
       * later entry waits for it to settle to keep the chain ordered.
       * A `success` or `failure` entry is appended once the outcome is known.
       */
      const attempt = emitRevocationAudit(req, {
        action: 'group.deleted',
        outcome: 'pending',
        severity: 'warning',
        target,
      });
      const record = async (outcome: 'success' | 'failure', code?: string) => {
        await attempt;
        return emitRevocationAudit(req, {
          action: 'group.deleted',
          outcome,
          severity: 'warning',
          target,
          ...(code ? { metadata: { code } } : {}),
        });
      };
      const recordFailure = (code: string) => record('failure', code);
      /**
       * Config overrides and ACL entries are keyed by group id, so they are
       * removed before the group itself: if any removal fails the group stays
       * and the admin can retry, instead of leaving orphaned entries that a later
       * principal could inherit. Only the config override is put back (insert-only,
       * so one written since is kept): removing it can widen what members may do,
       * while ACL entries stay removed because that only narrows access and
       * re-inserting them could resurrect a grant revoked in the meantime.
       * deleteAclEntries is a raw deleteMany wrapper with no type casting.
       * grantPermission stores group principalId as ObjectId, so we must
       * cast here. deleteConfig normalizes internally.
       */
      let restoreFailed = false;
      const cascade = await runCascade(
        [
          cascadeStep(
            'config',
            () => removeProfile(PrincipalType.GROUP, id),
            restoreProfile
              ? async (config) => {
                  if (!config) {
                    return;
                  }
                  let restored: boolean;
                  try {
                    restored = await restoreProfile(config);
                    restoreFailed = false;
                  } catch (error) {
                    restoreFailed = true;
                    throw error;
                  }
                  if (!restored) {
                    logger.warn('[adminGroups] config restore skipped, override exists:', id);
                  }
                }
              : undefined,
            findConfigByPrincipal
              ? () => findConfigByPrincipal(PrincipalType.GROUP, id, { includeInactive: true })
              : undefined,
          ),
          cascadeStep('acl', () =>
            deleteAclEntries({
              principalType: PrincipalType.GROUP,
              principalId: new Types.ObjectId(id),
            }),
          ),
        ],
        '[adminGroups]',
      );
      /**
       * Puts the config override back. When that restore itself fails the group would live on
       * without its restriction, so the deletion is completed instead of retaining it.
       */
      const compensate = async (): Promise<'restored' | 'stuck' | 'missing' | IGroup> => {
        await cascade.compensate();
        if (!restoreFailed) {
          return 'restored';
        }
        logger.error('[adminGroups] config restore failed, completing the deletion:', id);
        let removed: IGroup | null = null;
        try {
          removed = await deleteGroup(id);
          if (!removed) {
            /** Another request deleted the group first; this one removed nothing. */
            return 'missing';
          }
        } catch (error) {
          /** The delete may have committed before it threw (post-delete cache work); a confirmed
           * absence is a completed deletion. */
          const absent = await findGroupById(id).then(
            (group) => group == null,
            () => false,
          );
          if (!absent) {
            logger.error(
              '[adminGroups] group left without its config override:',
              id,
              getSafeErrorMetadata(error),
            );
            return 'stuck';
          }
          removed = existing;
        }
        /** The group is gone for good, so a leftover ACL entry is orphaned: retry its removal once. */
        await deleteAclEntries({
          principalType: PrincipalType.GROUP,
          principalId: new Types.ObjectId(id),
        }).catch((aclError) =>
          logger.error(
            '[adminGroups] acl cleanup retry failed after group deletion:',
            getSafeErrorMetadata(aclError),
          ),
        );
        return removed;
      };
      /** Every member loses group-scoped access, so the affected accounts are recorded (chunked). */
      const recordMemberRemovals = async (group: IGroup) => {
        /** Keeps the chain causal: the pending attempt precedes the member entries. */
        await attempt;
        const revoked = [...new Set(group.memberIds ?? [])];
        for (let i = 0; i < revoked.length; i += AUDIT_MEMBER_CHUNK) {
          const chunk = revoked.slice(i, i + AUDIT_MEMBER_CHUNK);
          await emitRevocationAudit(req, {
            action: 'group.member_removed',
            severity: 'warning',
            target: groupTarget(group, id),
            metadata: { userIds: chunk.join(','), count: chunk.length, cause: 'group_deleted' },
          });
        }
      };
      const compensatedResponse = async (outcome: 'stuck' | 'missing' | IGroup) => {
        if (outcome === 'missing') {
          await recordFailure('not_found');
          return res.status(404).json({ error: 'Group not found' });
        }
        if (outcome !== 'stuck') {
          await recordMemberRemovals(outcome);
          res.status(200).json({ success: true, id });
          await record('success');
          return res;
        }
        await recordFailure('GROUP_RESTORE_FAILED');
        return res.status(500).json({
          error: 'Failed to delete group and its config override could not be restored',
          code: 'GROUP_RESTORE_FAILED',
        });
      };
      const cleanupFailedResponse = async () => {
        await recordFailure('GROUP_CLEANUP_FAILED');
        return res.status(500).json({
          error: 'Failed to remove the group permissions and config; the group was not deleted',
          code: 'GROUP_CLEANUP_FAILED',
        });
      };

      if (cascade.failed.length > 0) {
        /** A concurrent delete may have removed the group meanwhile; restoring its config would
         * orphan it. When the lookup itself fails the group state is unknown, and putting the
         * override back is the safe side: a leftover override only restricts, a lost one widens. */
        const gone = await findGroupById(id).then(
          (group) => group == null,
          () => false,
        );
        if (!gone) {
          const outcome = await compensate();
          if (outcome !== 'restored') {
            return compensatedResponse(outcome);
          }
        }
        return cleanupFailedResponse();
      }

      let deleted: IGroup | null;
      try {
        deleted = await deleteGroup(id);
      } catch (error) {
        logger.error(
          '[adminGroups] deleteGroup failed after cascade cleanup:',
          getSafeErrorMetadata(error),
        );
        /** The delete may have committed before it threw. Restoring dependents for a
         * group that is gone would orphan them. */
        const lookup = await findGroupById(id).then(
          (group) => ({ known: true, group }),
          () => ({ known: false, group: null }),
        );
        if (lookup.known && lookup.group) {
          const outcome = await compensate();
          if (outcome !== 'restored') {
            return compensatedResponse(outcome);
          }
          await recordFailure('GROUP_CLEANUP_FAILED');
          return res.status(500).json({ error: 'Failed to delete group' });
        }
        if (!lookup.known) {
          /** Unknown state favors the restriction: a leftover override narrows access, a lost one widens it. */
          const outcome = await compensate();
          if (outcome !== 'restored') {
            return compensatedResponse(outcome);
          }
          logger.error('[adminGroups] group state unverifiable after delete failure:', id);
          await recordFailure('GROUP_STATE_UNVERIFIABLE');
          return res.status(500).json({ error: 'Failed to delete group' });
        }
        /** Confirmed absent: the deletion did commit. */
        deleted = existing;
      }
      if (!deleted) {
        await recordFailure('not_found');
        return res.status(404).json({ error: 'Group not found' });
      }
      await recordMemberRemovals(deleted);
      res.status(200).json({ success: true, id });
      await record('success');
      return res;
    } catch (error) {
      logger.error('[adminGroups] deleteGroup error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to delete group' });
    }
  }

  async function getGroupMembersHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as GroupIdParams;
      if (!isValidObjectIdString(id)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }
      const group = await findGroupById(id, { memberIds: 1 });
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }

      /**
       * `total` counts unique raw memberId strings. After user resolution, two
       * distinct strings may map to the same user, so `members.length` can be
       * less than the page size. Write paths prevent this for well-formed data.
       */
      const allMemberIds = [...new Set(group.memberIds || [])];
      const total = allMemberIds.length;
      const { limit, offset } = parsePagination(req.query);

      if (total === 0 || offset >= total) {
        return res.status(200).json({ members: [], total, limit, offset });
      }

      const memberIds = allMemberIds.slice(offset, offset + limit);

      const validObjectIds = memberIds.filter(isValidObjectIdString);
      const conditions: FilterQuery<IUser>[] = [{ idOnTheSource: { $in: memberIds } }];
      if (validObjectIds.length > 0) {
        conditions.push({ _id: { $in: validObjectIds } });
      }
      const users = await findUsers({ $or: conditions }, 'name email avatar idOnTheSource');

      const userMap = new Map<string, IUser>();
      for (const user of users) {
        if (user.idOnTheSource) {
          userMap.set(user.idOnTheSource, user);
        }
        if (user._id) {
          userMap.set(user._id.toString(), user);
        }
      }

      const seen = new Set<string>();
      const members: { userId: string; name: string; email: string; avatarUrl?: string }[] = [];
      for (const memberId of memberIds) {
        const user = userMap.get(memberId);
        const userId = user?._id?.toString() ?? memberId;
        if (seen.has(userId)) {
          continue;
        }
        seen.add(userId);
        members.push({
          userId,
          name: user?.name ?? memberId,
          email: user?.email ?? '',
          avatarUrl: user?.avatar,
        });
      }

      return res.status(200).json({ members, total, limit, offset });
    } catch (error) {
      logger.error('[adminGroups] getGroupMembers error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to get group members' });
    }
  }

  async function addGroupMemberHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as GroupIdParams;
      if (!isValidObjectIdString(id)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }
      const { userId } = req.body as { userId: string };
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
      }
      if (!isValidObjectIdString(userId)) {
        return res
          .status(400)
          .json({ error: 'Only native user ObjectIds can be added via this endpoint' });
      }

      const { group, changed } = await addUserToGroup(userId, id);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      if (changed) {
        await emitAudit(req, {
          action: 'group.member_added',
          severity: 'warning',
          target: groupTarget(group, id),
          metadata: { userId },
        });
      }
      return res.status(200).json({ group });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const isNotFound = message === 'User not found' || message.startsWith('User not found:');
      if (isNotFound) {
        return res.status(404).json({ error: 'User not found' });
      }
      logger.error('[adminGroups] addGroupMember error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to add member' });
    }
  }

  /**
   * Attempt removal of an ObjectId-format member: first via removeUserFromGroup
   * (which resolves the user), falling back to a raw $pull if the user record
   * no longer exists. Returns null only when the group itself is not found.
   */
  async function removeObjectIdMember(
    groupId: string,
    userId: string,
  ): Promise<{ group: IGroup | null; changed: boolean }> {
    try {
      const { group, changed } = await removeUserFromGroup(userId, groupId);
      return { group, changed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'User not found' || msg.startsWith('User not found:')) {
        return removeMemberByIdTracked(groupId, userId);
      }
      throw err;
    }
  }

  async function removeGroupMemberHandler(req: ServerRequest, res: Response) {
    try {
      const { id, userId } = req.params as GroupMemberParams;
      if (!isValidObjectIdString(id)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }

      const { group, changed } = isValidObjectIdString(userId)
        ? await removeObjectIdMember(id, userId)
        : await removeMemberByIdTracked(id, userId);

      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      if (changed) {
        await emitAudit(req, {
          action: 'group.member_removed',
          severity: 'warning',
          target: groupTarget(group, id),
          metadata: { userId },
        });
      }
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminGroups] removeGroupMember error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to remove member' });
    }
  }

  return {
    listGroups: listGroupsHandler,
    getGroup: getGroupHandler,
    createGroup: createGroupHandler,
    updateGroup: updateGroupHandler,
    deleteGroup: deleteGroupHandler,
    getGroupMembers: getGroupMembersHandler,
    addGroupMember: addGroupMemberHandler,
    removeGroupMember: removeGroupMemberHandler,
  };
}
