import { Types } from 'mongoose';
import { PrincipalType } from 'librechat-data-provider';
import { logger, isValidObjectIdString } from '@librechat/data-schemas';
import type {
  IGroup,
  IUser,
  IConfig,
  CreateGroupRequest,
  UpdateGroupRequest,
  GroupFilterOptions,
} from '@librechat/data-schemas';
import type { FilterQuery, ClientSession, DeleteResult } from 'mongoose';
import type { Response } from 'express';
import type { ValidationError } from '~/types/error';
import type { ServerRequest } from '~/types/http';
import { parsePagination } from './pagination';

type GroupListFilter = Pick<GroupFilterOptions, 'source' | 'search'>;

const VALID_GROUP_SOURCES: ReadonlySet<string> = new Set(['local', 'entra']);
const MAX_CREATE_MEMBER_IDS = 500;
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
  updateGroupById: (
    groupId: string | Types.ObjectId,
    data: Partial<Pick<IGroup, 'name' | 'description' | 'email' | 'avatar'>>,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  deleteGroup: (
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  addUserToGroup: (
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<{ user: IUser; group: IGroup | null }>;
  removeUserFromGroup: (
    userId: string | Types.ObjectId,
    groupId: string | Types.ObjectId,
    session?: ClientSession,
  ) => Promise<{ user: IUser; group: IGroup | null }>;
  removeMemberById: (
    groupId: string | Types.ObjectId,
    memberId: string,
    session?: ClientSession,
  ) => Promise<IGroup | null>;
  findUsers: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
  ) => Promise<IUser[]>;
  deleteConfig: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
  ) => Promise<IConfig | null>;
  deleteAclEntries: (filter: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
  }) => Promise<DeleteResult>;
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
    updateGroupById,
    deleteGroup,
    addUserToGroup,
    removeUserFromGroup,
    removeMemberById,
    findUsers,
    deleteConfig,
    deleteAclEntries,
  } = deps;

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
      logger.error('[adminGroups] listGroups error:', error);
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
      logger.error('[adminGroups] getGroup error:', error);
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
      return res.status(201).json({ group });
    } catch (error) {
      if ((error as ValidationError).name === 'ValidationError') {
        return res.status(400).json({ error: (error as ValidationError).message });
      }
      logger.error('[adminGroups] createGroup error:', error);
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

      const group = await updateGroupById(id, updateData);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      return res.status(200).json({ group });
    } catch (error) {
      if ((error as ValidationError).name === 'ValidationError') {
        return res.status(400).json({ error: (error as ValidationError).message });
      }
      logger.error('[adminGroups] updateGroup error:', error);
      return res.status(500).json({ error: 'Failed to update group' });
    }
  }

  async function deleteGroupHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as GroupIdParams;
      if (!isValidObjectIdString(id)) {
        return res.status(400).json({ error: 'Invalid group ID format' });
      }
      const deleted = await deleteGroup(id);
      if (!deleted) {
        return res.status(404).json({ error: 'Group not found' });
      }
      /**
       * deleteAclEntries is a raw deleteMany wrapper with no type casting.
       * grantPermission stores group principalId as ObjectId, so we must
       * cast here. deleteConfig normalizes internally.
       */
      const cleanupResults = await Promise.allSettled([
        deleteConfig(PrincipalType.GROUP, id),
        deleteAclEntries({
          principalType: PrincipalType.GROUP,
          principalId: new Types.ObjectId(id),
        }),
      ]);
      for (const result of cleanupResults) {
        if (result.status === 'rejected') {
          logger.error('[adminGroups] cascade cleanup step failed for group:', id, result.reason);
        }
      }
      return res.status(200).json({ success: true, id });
    } catch (error) {
      logger.error('[adminGroups] deleteGroup error:', error);
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
      logger.error('[adminGroups] getGroupMembers error:', error);
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

      const { group } = await addUserToGroup(userId, id);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      return res.status(200).json({ group });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const isNotFound = message === 'User not found' || message.startsWith('User not found:');
      if (isNotFound) {
        return res.status(404).json({ error: 'User not found' });
      }
      logger.error('[adminGroups] addGroupMember error:', error);
      return res.status(500).json({ error: 'Failed to add member' });
    }
  }

  /**
   * Attempt removal of an ObjectId-format member: first via removeUserFromGroup
   * (which resolves the user), falling back to a raw $pull if the user record
   * no longer exists. Returns null only when the group itself is not found.
   */
  async function removeObjectIdMember(groupId: string, userId: string): Promise<IGroup | null> {
    try {
      const { group } = await removeUserFromGroup(userId, groupId);
      return group;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'User not found' || msg.startsWith('User not found:')) {
        return removeMemberById(groupId, userId);
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

      const group = isValidObjectIdString(userId)
        ? await removeObjectIdMember(id, userId)
        : await removeMemberById(id, userId);

      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminGroups] removeGroupMember error:', error);
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
