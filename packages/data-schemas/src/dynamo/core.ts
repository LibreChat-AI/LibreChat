import { createHash, randomBytes } from 'node:crypto';
import {
  AUTH_USER_DOC_BY_ID_PREFIX,
  CacheKeys,
  roleDefaults,
  SystemRoles,
} from 'librechat-data-provider';
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { hashToken, signPayload } from '~/crypto';

export const DYNAMO_ITEM_LIMIT_BYTES: number = 380 * 1024;
export const DEFAULT_DYNAMO_TABLE: string = 'plastic-ai-core';
const DEFAULT_REFRESH_TOKEN_EXPIRY = 1000 * 60 * 60 * 24 * 7;
const DEFAULT_SESSION_EXPIRY = 1000 * 60 * 15;
const GSI_NAME = 'GSI1';
const DATE_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'archivedAt',
  'expiration',
  'expiresAt',
  'expiredAt',
  'termsAcceptedAt',
  'usedAt',
]);
const DEFAULT_HIDDEN_FIELDS = new Set([
  'password',
  'totpSecret',
  'backupCodes',
  'pendingTotpSecret',
  'pendingBackupCodes',
  'agentTriggerDeletionStartedAt',
  'subagentAdmissionFences',
  'pinnedOrder',
]);

type DynamoScalar = null | boolean | number | string | Date | Uint8Array;
export type DynamoValue = DynamoScalar | DynamoValue[] | { [key: string]: DynamoValue };
export type DynamoItem = { [key: string]: DynamoValue };
export type DynamoFilter = { [key: string]: DynamoValue | { $in: DynamoValue[] } };

export interface DynamoCoreConfig {
  tableName?: string;
  getCache?: (key: string) =>
    | {
        get?: (key: string) => Promise<DynamoValue | undefined>;
        delete?: (key: string) => Promise<boolean | void>;
      }
    | undefined;
}

export interface DynamoCoreMethods {
  findUser: (
    criteria: DynamoFilter,
    fields?: string | string[] | null,
  ) => Promise<DynamoItem | null>;
  findUsers: (criteria: DynamoFilter, fields?: string | string[] | null) => Promise<DynamoItem[]>;
  countUsers: (criteria?: DynamoFilter) => Promise<number>;
  createUser: (
    data: DynamoItem,
    balanceConfig?: DynamoItem,
    disableTTL?: boolean,
    returnUser?: boolean,
  ) => Promise<string | DynamoItem>;
  updateUser: (userId: string, update: DynamoItem) => Promise<DynamoItem | null>;
  getUserById: (userId: string, fields?: string | string[] | null) => Promise<DynamoItem | null>;
  isAgentTriggerPrincipalActive: (userId: string) => Promise<boolean>;
  deleteUserById: (userId: string) => Promise<{ deletedCount: number; message: string }>;
  generateToken: (user: DynamoItem, expiresIn?: number) => Promise<string>;
  acceptTerms: (userId: string) => Promise<DynamoItem | null>;
  updateUserPlugins: (
    userId: string,
    plugins: string[] | undefined,
    pluginKey: string,
    action: 'install' | 'uninstall',
  ) => Promise<DynamoItem | null>;
  toggleUserMemories: (userId: string, enabled: boolean) => Promise<DynamoItem | null>;
  updateUserStatefulCodeEnvironment: (
    userId: string,
    environment: DynamoValue,
  ) => Promise<DynamoItem | null>;
  findSession: (params: DynamoItem) => Promise<DynamoItem | null>;
  createSession: (
    userId: string,
    options?: { expiration?: Date; expiresIn?: number },
  ) => Promise<{ session: DynamoItem; refreshToken: string }>;
  upsertSession: (
    userId: string,
    refreshToken: string,
    options: { expiration: Date; tenantId?: string },
  ) => Promise<DynamoItem>;
  deleteSession: (params: DynamoItem) => Promise<{ deletedCount: number }>;
  deleteAllUserSessions: (
    userId: string | { userId: string },
    options?: { excludeCurrentSession?: boolean; currentSessionId?: string },
  ) => Promise<{ deletedCount: number }>;
  updateExpiration: (
    session: DynamoItem | string,
    expiration?: Date,
    options?: { expiresIn?: number },
  ) => Promise<DynamoItem>;
  countActiveSessions: (userId: string) => Promise<number>;
  generateRefreshToken: (session: DynamoItem) => Promise<string>;
  ensureSessionIndexes: () => Promise<void>;
  initializeRoles: () => Promise<void>;
  seedDefaultRoles: () => Promise<void>;
  seedSystemGrants: () => Promise<void>;
  getRoleByName: (roleName: string, fields?: string | string[] | null) => Promise<DynamoItem>;
  findRolesByNames: (roleNames: string[]) => Promise<DynamoItem[]>;
  updateRoleByName: (roleName: string, updates: DynamoItem) => Promise<DynamoItem>;
  updateAccessPermissions: (
    roleName: string,
    permissions: { [key: string]: { [key: string]: boolean } },
  ) => Promise<void>;
  searchConversation: (conversationId: string) => Promise<DynamoItem | null>;
  getConvo: (user: string, conversationId: string) => Promise<DynamoItem | null>;
  getConvoOwnership: (
    user: string,
    conversationId: string,
    tenantId?: string | null,
  ) => Promise<DynamoItem | null>;
  getConvoRetention: (user: string, conversationId: string) => Promise<DynamoItem | null>;
  getConvoFiles: (conversationId: string) => Promise<string[]>;
  getConvoTitle: (user: string, conversationId: string) => Promise<string | null>;
  saveConvo: (
    context: { userId: string; isTemporary?: boolean; expiredAt?: Date },
    conversation: DynamoItem,
    metadata?: {
      unsetFields?: { [key: string]: number };
      noUpsert?: boolean;
      createdAtOnInsert?: Date;
      preserveUpdatedAt?: boolean;
    },
  ) => Promise<DynamoItem | null>;
  setConvoPinned: (
    user: string,
    conversationId: string,
    pinned: boolean,
  ) => Promise<DynamoItem | null>;
  getConvosByCursor: (
    user: string,
    options?: DynamoItem,
  ) => Promise<{ conversations: DynamoItem[]; nextCursor: string | null }>;
  getConvosQueried: (
    user: string,
    conversations: Array<{ conversationId: string }> | null,
    cursor?: string,
    limit?: number,
  ) => Promise<{ conversations: DynamoItem[]; nextCursor: string | null }>;
  deleteConvos: (
    user: string,
    filter: DynamoFilter,
    options?: { beforeDelete?: (ids: string[]) => Promise<void>; allowEmpty?: boolean },
  ) => Promise<{
    deletedCount: number;
    messages: { deletedCount: number };
    conversationIds: string[];
  }>;
  archiveAllConvos: (user: string) => Promise<{ archivedCount: number }>;
  saveMessage: (
    context: { userId: string; isTemporary?: boolean; expiredAt?: Date },
    message: DynamoItem,
  ) => Promise<DynamoItem | undefined>;
  bulkSaveMessages: (messages: DynamoItem[], ordered?: boolean) => Promise<DynamoItem[]>;
  recordMessage: (message: DynamoItem) => Promise<DynamoItem | undefined>;
  updateMessageText: (
    userId: string,
    message: { messageId: string; text: string },
  ) => Promise<void>;
  updateMessage: (userId: string, message: DynamoItem) => Promise<DynamoItem>;
  getMessage: (params: { user: string; messageId: string }) => Promise<DynamoItem | null>;
  getMessages: (
    filter: DynamoFilter,
    select?: string,
    options?: { sort?: false | { [key: string]: 1 | -1 }; limit?: number },
  ) => Promise<DynamoItem[]>;
  getMessagesByCursor: (
    filter: DynamoFilter,
    options?: { sortOrder?: 1 | -1; limit?: number; cursor?: string | null; select?: string },
  ) => Promise<{ messages: DynamoItem[]; nextCursor: string | null }>;
  deleteMessages: (filter: DynamoFilter) => Promise<{ deletedCount: number }>;
  deleteMessagesSince: (
    userId: string,
    params: { messageId: string; conversationId: string },
  ) => Promise<{ deletedCount: number } | undefined>;
}

export class DynamoItemTooLargeError extends Error {
  public readonly statusCode = 413;
  public readonly code = 'item_too_large';

  constructor() {
    super('The record is too large for DynamoDB.');
    this.name = 'DynamoItemTooLargeError';
  }
}

const id = (): string => randomBytes(12).toString('hex');
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const userKey = (userId: string): DynamoItem => ({ PK: `USER#${userId}`, SK: 'PROFILE' });
const roleKey = (roleName: string): DynamoItem => ({ PK: 'SYSTEM', SK: `ROLE#${roleName}` });
const convoKey = (conversationId: string): DynamoItem => ({
  PK: `CONVERSATION#${conversationId}`,
  SK: 'DETAIL',
});
const messageLocatorKey = (messageId: string): DynamoItem => ({
  PK: `MESSAGE#${messageId}`,
  SK: 'LOCATOR',
});
const sessionLocatorKey = (sessionId: string): DynamoItem => ({
  PK: `SESSION_ID#${sessionId}`,
  SK: 'LOCATOR',
});

const isDynamoItem = (value: DynamoValue | undefined): value is DynamoItem =>
  value != null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof Uint8Array);

const inValues = (value: DynamoValue | undefined): DynamoValue[] | undefined =>
  isDynamoItem(value) && Array.isArray(value.$in) ? value.$in : undefined;

const toStoredItem = (value: DynamoItem): DynamoItem =>
  JSON.parse(JSON.stringify(value)) as DynamoItem;

const hydrateValue = (key: string, value: DynamoValue): DynamoValue => {
  if (DATE_FIELDS.has(key) && typeof value === 'string') {
    return new Date(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => hydrateValue('', entry));
  }
  if (isDynamoItem(value)) {
    return hydrateItem(value);
  }
  return value;
};

const hydrateItem = (item: DynamoItem): DynamoItem =>
  Object.fromEntries(Object.entries(item).map(([key, value]) => [key, hydrateValue(key, value)]));

const cleanItem = (item: DynamoItem): DynamoItem => {
  const { PK: _pk, SK: _sk, GSI1PK: _gsiPk, GSI1SK: _gsiSk, version: _version, ...record } = item;
  return hydrateItem(record);
};

const project = (item: DynamoItem | null, fields?: string | string[] | null): DynamoItem | null => {
  if (item == null) {
    return item;
  }
  const names = (fields == null ? [] : Array.isArray(fields) ? fields : fields.split(/\s+/)).filter(
    Boolean,
  );
  const excluded = new Set(
    names.filter((name) => name.startsWith('-')).map((name) => name.slice(1)),
  );
  const forced = new Set(names.filter((name) => name.startsWith('+')).map((name) => name.slice(1)));
  const included = names.filter((name) => !name.startsWith('-') && !name.startsWith('+'));
  if (included.length === 0) {
    return Object.fromEntries(
      Object.entries(item).filter(
        ([key]) => !excluded.has(key) && (!DEFAULT_HIDDEN_FIELDS.has(key) || forced.has(key)),
      ),
    );
  }
  return Object.fromEntries(
    Object.entries(item).filter(
      ([key]) => included.includes(key) || forced.has(key) || key === '_id' || key === 'id',
    ),
  );
};

const assertItemSize = (item: DynamoItem): void => {
  if (Buffer.byteLength(JSON.stringify(item), 'utf8') > DYNAMO_ITEM_LIMIT_BYTES) {
    throw new DynamoItemTooLargeError();
  }
};

const valueString = (value: DynamoValue | undefined): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  return value instanceof Date ? value.toISOString() : undefined;
};

const valueBoolean = (value: DynamoValue | undefined): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const valueNumber = (value: DynamoValue | undefined): number | undefined =>
  typeof value === 'number' ? value : undefined;

const matches = (item: DynamoItem, filter: DynamoFilter): boolean =>
  Object.entries(filter).every(([key, expected]) => {
    const accepted = inValues(expected);
    if (accepted != null) {
      return accepted.includes(item[key]);
    }
    return item[key] === expected;
  });

export function createDynamoCoreMethods(
  client: DynamoDBDocumentClient,
  config: DynamoCoreConfig = {},
): DynamoCoreMethods {
  const TableName = config.tableName ?? DEFAULT_DYNAMO_TABLE;

  const invalidateAuthUserDocCache = async (userId: string): Promise<void> => {
    if (process.env.AUTH_USER_CACHE_MODE !== 'on') {
      return;
    }
    const cache = config.getCache?.(CacheKeys.AUTH_USER_DOC);
    if (cache?.get == null || cache.delete == null) {
      return;
    }
    try {
      const indexKey = `${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`;
      const cachedKeys = await cache.get(indexKey);
      if (Array.isArray(cachedKeys)) {
        await Promise.all(
          cachedKeys.map((key) =>
            typeof key === 'string' ? cache.delete?.(key) : Promise.resolve(),
          ),
        );
      }
      await cache.delete(indexKey);
    } catch {
      // Cache invalidation must not make a persistence mutation fail.
    }
  };

  const getItem = async (key: DynamoItem): Promise<DynamoItem | null> => {
    const result = await client.send(new GetCommand({ TableName, Key: key, ConsistentRead: true }));
    return result.Item == null ? null : (result.Item as DynamoItem);
  };

  const putItem = async (
    item: DynamoItem,
    options: {
      conditionExpression?: string;
      expressionAttributeNames?: { [key: string]: string };
      expressionAttributeValues?: { [key: string]: DynamoValue };
    } = {},
  ): Promise<void> => {
    const stored = toStoredItem(item);
    assertItemSize(stored);
    await client.send(
      new PutCommand({
        TableName,
        Item: stored,
        ConditionExpression: options.conditionExpression,
        ExpressionAttributeNames: options.expressionAttributeNames,
        ExpressionAttributeValues: options.expressionAttributeValues,
      }),
    );
  };

  const queryAll = async (input: {
    IndexName?: string;
    KeyConditionExpression: string;
    ExpressionAttributeNames?: { [key: string]: string };
    ExpressionAttributeValues: { [key: string]: DynamoValue };
    ScanIndexForward?: boolean;
    Limit?: number;
    ExclusiveStartKey?: DynamoItem;
  }): Promise<{ items: DynamoItem[]; lastKey?: DynamoItem }> => {
    const result = await client.send(new QueryCommand({ TableName, ...input }));
    return {
      items: (result.Items ?? []) as DynamoItem[],
      ...(result.LastEvaluatedKey == null
        ? {}
        : { lastKey: result.LastEvaluatedKey as DynamoItem }),
    };
  };

  const readUser = async (userId: string): Promise<DynamoItem | null> => {
    const item = await getItem(userKey(userId));
    return item == null ? null : cleanItem(item);
  };

  const findUser = async (
    criteria: DynamoFilter,
    fields?: string | string[] | null,
  ): Promise<DynamoItem | null> => {
    const directId = valueString(criteria._id) ?? valueString(criteria.id);
    if (directId != null) {
      return project(await readUser(directId), fields);
    }
    const email = valueString(criteria.email)?.trim().toLowerCase();
    if (email != null) {
      const tenant = valueString(criteria.tenantId) ?? 'default';
      const lock = await getItem({ PK: `EMAIL#${digest(`${tenant}:${email}`)}`, SK: 'LOCK' });
      const userId = lock == null ? undefined : valueString(lock.userId);
      const user = userId == null ? null : await readUser(userId);
      return user != null && matches(user, criteria) ? project(user, fields) : null;
    }
    const result = await client.send(
      new ScanCommand({
        TableName,
        FilterExpression: 'SK = :profile',
        ExpressionAttributeValues: { ':profile': 'PROFILE' },
      }),
    );
    const found = ((result.Items ?? []) as DynamoItem[])
      .map(cleanItem)
      .find((item) => matches(item, criteria));
    return project(found ?? null, fields);
  };

  const findUsers = async (
    criteria: DynamoFilter,
    fields?: string | string[] | null,
  ): Promise<DynamoItem[]> => {
    const result = await client.send(
      new ScanCommand({
        TableName,
        FilterExpression: 'SK = :profile',
        ExpressionAttributeValues: { ':profile': 'PROFILE' },
      }),
    );
    return ((result.Items ?? []) as DynamoItem[])
      .map(cleanItem)
      .filter((item) => matches(item, criteria))
      .map((item) => project(item, fields) ?? item);
  };

  const countUsers = async (criteria: DynamoFilter = {}): Promise<number> =>
    (await findUsers(criteria)).length;

  const createUser = async (
    data: DynamoItem,
    _balanceConfig?: DynamoItem,
    disableTTL = true,
    returnUser = false,
  ): Promise<string | DynamoItem> => {
    const userId = id();
    const now = new Date().toISOString();
    const email = valueString(data.email)?.trim().toLowerCase();
    if (email == null) {
      throw new TypeError('User email is required');
    }
    const tenant = valueString(data.tenantId) ?? 'default';
    const record: DynamoItem = {
      ...toStoredItem(data),
      _id: userId,
      id: userId,
      email,
      emailVerified: valueBoolean(data.emailVerified) ?? false,
      provider: valueString(data.provider) ?? 'local',
      createdAt: now,
      updatedAt: now,
      ...(!disableTTL ? { expiresAt: Math.floor(Date.now() / 1000) + 604800 } : {}),
    };
    const item: DynamoItem = {
      ...userKey(userId),
      ...record,
      GSI1PK: 'USERS',
      GSI1SK: `${now}#${userId}`,
      version: 1,
    };
    assertItemSize(item);
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName,
              Item: { PK: `EMAIL#${digest(`${tenant}:${email}`)}`, SK: 'LOCK', userId },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          { Put: { TableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      }),
    );
    return returnUser ? (project(cleanItem(item)) ?? {}) : userId;
  };

  const updateUser = async (userId: string, update: DynamoItem): Promise<DynamoItem | null> => {
    const currentItem = await getItem(userKey(userId));
    if (currentItem == null) {
      return null;
    }
    const current = cleanItem(currentItem);
    const expectedVersion = valueNumber(currentItem.version) ?? 1;
    const next: DynamoItem = {
      ...current,
      ...toStoredItem(update),
      _id: userId,
      id: userId,
      updatedAt: new Date().toISOString(),
    };
    delete next.expiresAt;
    await putItem(
      {
        ...userKey(userId),
        ...next,
        GSI1PK: 'USERS',
        GSI1SK: `${valueString(current.createdAt) ?? new Date().toISOString()}#${userId}`,
        version: expectedVersion + 1,
      },
      {
        conditionExpression: '#version = :expectedVersion',
        expressionAttributeNames: { '#version': 'version' },
        expressionAttributeValues: { ':expectedVersion': expectedVersion },
      },
    );
    await invalidateAuthUserDocCache(userId);
    return project(hydrateItem(next));
  };

  const getUserById = async (
    userId: string,
    fields?: string | string[] | null,
  ): Promise<DynamoItem | null> => project(await readUser(String(userId)), fields);

  const isAgentTriggerPrincipalActive = async (userId: string): Promise<boolean> => {
    const user = await readUser(userId);
    return user != null && user.agentTriggerDeletionStartedAt == null;
  };

  const deleteUserById = async (
    userId: string,
  ): Promise<{ deletedCount: number; message: string }> => {
    const user = await readUser(userId);
    if (user == null) {
      return { deletedCount: 0, message: 'No user found with that ID.' };
    }
    const email = valueString(user.email) ?? '';
    const tenant = valueString(user.tenantId) ?? 'default';
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName, Key: userKey(userId) } },
          {
            Delete: { TableName, Key: { PK: `EMAIL#${digest(`${tenant}:${email}`)}`, SK: 'LOCK' } },
          },
        ],
      }),
    );
    await invalidateAuthUserDocCache(userId);
    return { deletedCount: 1, message: 'User was deleted successfully.' };
  };

  const generateToken = async (user: DynamoItem, expiresIn?: number): Promise<string> =>
    signPayload({
      payload: {
        id: valueString(user._id),
        username: valueString(user.username),
        provider: valueString(user.provider),
        email: valueString(user.email),
      },
      secret: process.env.JWT_SECRET,
      expirationTime: (expiresIn ?? DEFAULT_SESSION_EXPIRY) / 1000,
    });

  const acceptTerms = async (userId: string): Promise<DynamoItem | null> =>
    updateUser(userId, { termsAccepted: true, termsAcceptedAt: new Date().toISOString() });

  const updateUserPlugins = async (
    userId: string,
    plugins: string[] | undefined,
    pluginKey: string,
    action: 'install' | 'uninstall',
  ): Promise<DynamoItem | null> => {
    const values = new Set(plugins ?? []);
    action === 'install' ? values.add(pluginKey) : values.delete(pluginKey);
    return updateUser(userId, { plugins: [...values] });
  };

  const toggleUserMemories = async (
    userId: string,
    enabled: boolean,
  ): Promise<DynamoItem | null> => {
    const user = await readUser(userId);
    const personalization =
      user?.personalization != null &&
      typeof user.personalization === 'object' &&
      !Array.isArray(user.personalization)
        ? user.personalization
        : {};
    return updateUser(userId, { personalization: { ...personalization, memories: enabled } });
  };

  const updateUserStatefulCodeEnvironment = async (
    userId: string,
    environment: DynamoValue,
  ): Promise<DynamoItem | null> => {
    const user = await readUser(userId);
    const personalization =
      user?.personalization != null &&
      typeof user.personalization === 'object' &&
      !Array.isArray(user.personalization)
        ? user.personalization
        : {};
    return updateUser(userId, {
      personalization: { ...personalization, statefulCodeEnvironment: environment },
    });
  };

  const sessionFromItem = (item: DynamoItem): DynamoItem => cleanItem(item);

  const resolveSessionById = async (sessionId: string): Promise<DynamoItem | null> => {
    const locator = await getItem(sessionLocatorKey(sessionId));
    const tokenHash = locator == null ? undefined : valueString(locator.refreshTokenHash);
    if (tokenHash == null) {
      return null;
    }
    const item = await getItem({ PK: `SESSION#${tokenHash}`, SK: 'SESSION' });
    return item == null ? null : sessionFromItem(item);
  };

  const findSession = async (params: DynamoItem): Promise<DynamoItem | null> => {
    let session: DynamoItem | null = null;
    const refreshToken = valueString(params.refreshToken);
    if (refreshToken != null) {
      const tokenHash = await hashToken(refreshToken);
      const item = await getItem({ PK: `SESSION#${tokenHash}`, SK: 'SESSION' });
      session = item == null ? null : sessionFromItem(item);
    } else {
      const sessionValue = params.sessionId;
      const sessionId =
        typeof sessionValue === 'string'
          ? sessionValue
          : isDynamoItem(sessionValue)
            ? valueString(sessionValue.sessionId)
            : undefined;
      if (sessionId != null) {
        session = await resolveSessionById(sessionId);
      }
    }
    if (session == null || (valueString(params.userId) != null && session.user !== params.userId)) {
      return null;
    }
    const expiration = valueString(session.expiration);
    return expiration != null && new Date(expiration).getTime() > Date.now() ? session : null;
  };

  const persistSession = async (session: DynamoItem, tokenHash: string): Promise<void> => {
    const sessionId = valueString(session._id);
    const userId = valueString(session.user);
    const createdAt = valueString(session.createdAt) ?? new Date().toISOString();
    if (sessionId == null || userId == null) {
      throw new TypeError('Invalid session');
    }
    const expiration = valueString(session.expiration);
    const item: DynamoItem = {
      PK: `SESSION#${tokenHash}`,
      SK: 'SESSION',
      ...toStoredItem(session),
      refreshTokenHash: tokenHash,
      expiresAt: Math.floor(new Date(expiration ?? 0).getTime() / 1000),
      GSI1PK: `USER#${userId}`,
      GSI1SK: `SESSION#${createdAt}#${sessionId}`,
    };
    assertItemSize(item);
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName, Item: item } },
          {
            Put: {
              TableName,
              Item: { ...sessionLocatorKey(sessionId), refreshTokenHash: tokenHash },
            },
          },
        ],
      }),
    );
  };

  const generateRefreshToken = async (session: DynamoItem): Promise<string> => {
    const expiration =
      valueString(session.expiration) ??
      new Date(Date.now() + DEFAULT_REFRESH_TOKEN_EXPIRY).toISOString();
    const refreshToken = await signPayload({
      payload: { id: session.user, sessionId: session._id },
      secret: process.env.JWT_REFRESH_SECRET,
      expirationTime: Math.floor((new Date(expiration).getTime() - Date.now()) / 1000),
    });
    const tokenHash = await hashToken(refreshToken);
    await persistSession({ ...session, expiration, refreshTokenHash: tokenHash }, tokenHash);
    return refreshToken;
  };

  const createSession = async (
    userId: string,
    options: { expiration?: Date; expiresIn?: number } = {},
  ): Promise<{ session: DynamoItem; refreshToken: string }> => {
    const now = new Date().toISOString();
    const session: DynamoItem = {
      _id: id(),
      user: String(userId),
      expiration: (
        options.expiration ??
        new Date(Date.now() + (options.expiresIn ?? DEFAULT_REFRESH_TOKEN_EXPIRY))
      ).toISOString(),
      createdAt: now,
      updatedAt: now,
    };
    const refreshToken = await generateRefreshToken(session);
    return { session: hydrateItem(session), refreshToken };
  };

  const upsertSession = async (
    userId: string,
    refreshToken: string,
    options: { expiration: Date; tenantId?: string },
  ): Promise<DynamoItem> => {
    const tokenHash = await hashToken(refreshToken);
    const currentItem = await getItem({ PK: `SESSION#${tokenHash}`, SK: 'SESSION' });
    const current = currentItem == null ? null : sessionFromItem(currentItem);
    const now = new Date().toISOString();
    const session: DynamoItem = {
      ...(current ?? {}),
      _id: valueString(current?._id) ?? id(),
      user: userId,
      refreshTokenHash: tokenHash,
      expiration: options.expiration.toISOString(),
      ...(options.tenantId == null ? {} : { tenantId: options.tenantId }),
      createdAt: valueString(current?.createdAt) ?? now,
      updatedAt: now,
    };
    await persistSession(session, tokenHash);
    return hydrateItem(session);
  };

  const deleteSession = async (params: DynamoItem): Promise<{ deletedCount: number }> => {
    let session: DynamoItem | null = null;
    const refreshToken = valueString(params.refreshToken);
    if (refreshToken != null) {
      session = await findSession({ refreshToken });
    } else if (typeof params.sessionId === 'string') {
      session = await resolveSessionById(params.sessionId);
    }
    if (session == null) {
      return { deletedCount: 0 };
    }
    const sessionId = valueString(session._id) ?? '';
    const tokenHash = valueString(session.refreshTokenHash) ?? '';
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName, Key: { PK: `SESSION#${tokenHash}`, SK: 'SESSION' } } },
          { Delete: { TableName, Key: sessionLocatorKey(sessionId) } },
        ],
      }),
    );
    return { deletedCount: 1 };
  };

  const listUserSessions = async (userId: string): Promise<DynamoItem[]> => {
    const result = await queryAll({
      IndexName: GSI_NAME,
      KeyConditionExpression: 'GSI1PK = :user AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':user': `USER#${userId}`, ':prefix': 'SESSION#' },
    });
    return result.items.map(sessionFromItem);
  };

  const deleteAllUserSessions = async (
    input: string | { userId: string },
    options: { excludeCurrentSession?: boolean; currentSessionId?: string } = {},
  ): Promise<{ deletedCount: number }> => {
    const userId = typeof input === 'string' ? input : input.userId;
    const sessions = (await listUserSessions(userId)).filter(
      (session) => !(options.excludeCurrentSession && session._id === options.currentSessionId),
    );
    await Promise.all(
      sessions.map((session) => deleteSession({ sessionId: session._id as string })),
    );
    return { deletedCount: sessions.length };
  };

  const updateExpiration = async (
    input: DynamoItem | string,
    expiration?: Date,
    options: { expiresIn?: number } = {},
  ): Promise<DynamoItem> => {
    const session = typeof input === 'string' ? await resolveSessionById(input) : input;
    if (session == null) {
      throw new Error('Session not found');
    }
    const next = {
      ...session,
      expiration: (
        expiration ?? new Date(Date.now() + (options.expiresIn ?? DEFAULT_REFRESH_TOKEN_EXPIRY))
      ).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await persistSession(next, valueString(session.refreshTokenHash) ?? '');
    return hydrateItem(next);
  };

  const countActiveSessions = async (userId: string): Promise<number> =>
    (await listUserSessions(userId)).filter(
      (session) => new Date(valueString(session.expiration) ?? 0).getTime() > Date.now(),
    ).length;

  const ensureSessionIndexes = async (): Promise<void> => undefined;

  const getRoleByName = async (
    roleName: string,
    fields?: string | string[] | null,
  ): Promise<DynamoItem> => {
    const existing = await getItem(roleKey(roleName));
    if (existing != null) {
      return project(cleanItem(existing), fields) ?? {};
    }
    const defaults = roleDefaults[roleName as keyof typeof roleDefaults];
    const role: DynamoItem = toStoredItem({
      ...(defaults as DynamoItem),
      _id: roleName,
      name: roleName,
      description: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await putItem({ ...roleKey(roleName), ...role });
    return project(hydrateItem(role), fields) ?? role;
  };

  const initializeRoles = async (): Promise<void> => {
    await Promise.all([getRoleByName(SystemRoles.ADMIN), getRoleByName(SystemRoles.USER)]);
  };

  const findRolesByNames = async (roleNames: string[]): Promise<DynamoItem[]> =>
    Promise.all(roleNames.map((roleName) => getRoleByName(roleName)));

  const updateRoleByName = async (roleName: string, updates: DynamoItem): Promise<DynamoItem> => {
    const role = {
      ...(await getRoleByName(roleName)),
      ...toStoredItem(updates),
      name: roleName,
      updatedAt: new Date().toISOString(),
    };
    await putItem({ ...roleKey(roleName), ...role });
    return hydrateItem(role);
  };

  const updateAccessPermissions = async (
    roleName: string,
    permissions: { [key: string]: { [key: string]: boolean } },
  ): Promise<void> => {
    const role = await getRoleByName(roleName);
    const current =
      role.permissions != null &&
      typeof role.permissions === 'object' &&
      !Array.isArray(role.permissions)
        ? role.permissions
        : {};
    await updateRoleByName(roleName, { permissions: { ...current, ...permissions } });
  };

  const seedDefaultRoles = initializeRoles;
  const seedSystemGrants = async (): Promise<void> => undefined;

  const readConvo = async (conversationId: string): Promise<DynamoItem | null> => {
    const item = await getItem(convoKey(conversationId));
    return item == null ? null : cleanItem(item);
  };

  const searchConversation = async (conversationId: string): Promise<DynamoItem | null> =>
    readConvo(conversationId);

  const getConvo = async (user: string, conversationId: string): Promise<DynamoItem | null> => {
    const convo = await readConvo(conversationId);
    return convo?.user === user ? convo : null;
  };

  const getConvoOwnership = async (
    user: string,
    conversationId: string,
    tenantId?: string | null,
  ): Promise<DynamoItem | null> => {
    const convo = await getConvo(user, conversationId);
    if (convo == null || (tenantId != null && convo.tenantId !== tenantId)) {
      return null;
    }
    return convo;
  };

  const getConvoRetention = getConvo;

  const getConvoFiles = async (conversationId: string): Promise<string[]> => {
    const convo = await readConvo(conversationId);
    return Array.isArray(convo?.files)
      ? convo.files.filter((file): file is string => typeof file === 'string')
      : [];
  };

  const saveConvo = async (
    context: { userId: string; isTemporary?: boolean; expiredAt?: Date },
    conversation: DynamoItem,
    metadata: {
      unsetFields?: { [key: string]: number };
      noUpsert?: boolean;
      createdAtOnInsert?: Date;
      preserveUpdatedAt?: boolean;
    } = {},
  ): Promise<DynamoItem | null> => {
    const conversationId = valueString(conversation.conversationId);
    if (conversationId == null) {
      throw new TypeError('conversationId is required');
    }
    const currentItem = await getItem(convoKey(conversationId));
    const current = currentItem == null ? null : cleanItem(currentItem);
    if (current == null && metadata.noUpsert) {
      return null;
    }
    if (current != null && current.user !== context.userId) {
      return null;
    }
    const expectedVersion = valueNumber(currentItem?.version) ?? 0;
    const now = new Date().toISOString();
    const next: DynamoItem = {
      ...(current ?? {}),
      ...toStoredItem(conversation),
      _id: valueString(current?._id) ?? id(),
      conversationId,
      user: context.userId,
      createdAt:
        valueString(current?.createdAt) ?? metadata.createdAtOnInsert?.toISOString() ?? now,
      updatedAt: metadata.preserveUpdatedAt ? (valueString(current?.updatedAt) ?? now) : now,
      version: expectedVersion + 1,
    };
    if (context.isTemporary != null) {
      next.isTemporary = context.isTemporary;
    }
    if (context.expiredAt != null) {
      next.expiredAt = context.expiredAt.toISOString();
      next.expiresAt = Math.floor(context.expiredAt.getTime() / 1000);
    }
    for (const field of Object.keys(metadata.unsetFields ?? {})) {
      delete next[field];
    }
    const item: DynamoItem = {
      ...convoKey(conversationId),
      ...next,
      GSI1PK: `USER#${context.userId}`,
      GSI1SK: `CONVERSATION#${valueString(next.updatedAt) ?? now}#${conversationId}`,
    };
    await putItem(item, {
      conditionExpression:
        currentItem == null
          ? 'attribute_not_exists(PK)'
          : '#version = :expectedVersion AND #user = :user',
      expressionAttributeNames:
        currentItem == null ? undefined : { '#version': 'version', '#user': 'user' },
      expressionAttributeValues:
        currentItem == null
          ? undefined
          : { ':expectedVersion': expectedVersion, ':user': context.userId },
    });
    return cleanItem(item);
  };

  const setConvoPinned = async (
    user: string,
    conversationId: string,
    pinned: boolean,
  ): Promise<DynamoItem | null> =>
    saveConvo(
      { userId: user },
      { conversationId, pinned },
      { noUpsert: true, preserveUpdatedAt: true },
    );

  const decodeCursor = (cursor: string | undefined): DynamoItem | undefined => {
    if (cursor == null || cursor === '') {
      return undefined;
    }
    try {
      return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as DynamoItem;
    } catch {
      return undefined;
    }
  };

  const getConvosByCursor = async (
    user: string,
    options: DynamoItem = {},
  ): Promise<{ conversations: DynamoItem[]; nextCursor: string | null }> => {
    if (typeof options.search === 'string' && options.search !== '') {
      throw new Error('Conversation search is unsupported with DynamoDB');
    }
    const limit = Math.min(Math.max(valueNumber(options.limit) ?? 25, 1), 100);
    const result = await queryAll({
      IndexName: GSI_NAME,
      KeyConditionExpression: 'GSI1PK = :user AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':user': `USER#${user}`, ':prefix': 'CONVERSATION#' },
      ScanIndexForward: valueString(options.sortDirection) === 'asc',
      Limit: limit + 1,
      ExclusiveStartKey: decodeCursor(valueString(options.cursor)),
    });
    const archived = valueBoolean(options.isArchived) ?? false;
    const pinned = valueBoolean(options.pinned);
    const conversations = result.items
      .map(cleanItem)
      .filter((convo) => (valueBoolean(convo.isArchived) ?? false) === archived)
      .filter((convo) => pinned == null || valueBoolean(convo.pinned) === pinned)
      .slice(0, limit);
    return {
      conversations,
      nextCursor:
        result.lastKey == null
          ? null
          : Buffer.from(JSON.stringify(result.lastKey)).toString('base64url'),
    };
  };

  const getConvosQueried = async (
    user: string,
    conversations: Array<{ conversationId: string }> | null,
    cursor?: string,
    limit = 25,
  ): Promise<{ conversations: DynamoItem[]; nextCursor: string | null }> => {
    const requested =
      conversations == null ? [] : conversations.map(({ conversationId }) => conversationId);
    const rows = (
      await Promise.all(requested.map((conversationId) => getConvo(user, conversationId)))
    ).filter((convo): convo is DynamoItem => convo != null);
    const offset = cursor == null ? 0 : Number.parseInt(cursor, 10) || 0;
    const page = rows.slice(offset, offset + limit);
    return {
      conversations: page,
      nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
    };
  };

  const getConvoTitle = async (user: string, conversationId: string): Promise<string | null> => {
    const convo = await getConvo(user, conversationId);
    return convo == null ? null : (valueString(convo.title) ?? 'New Chat');
  };

  const getMessage = async ({
    user,
    messageId,
  }: {
    user: string;
    messageId: string;
  }): Promise<DynamoItem | null> => {
    const locator = await getItem(messageLocatorKey(messageId));
    const conversationId = locator == null ? undefined : valueString(locator.conversationId);
    const sortKey = locator == null ? undefined : valueString(locator.messageSortKey);
    if (conversationId == null || sortKey == null) {
      return null;
    }
    const item = await getItem({ PK: `CONVERSATION#${conversationId}`, SK: sortKey });
    const message = item == null ? null : cleanItem(item);
    return message?.user === user ? message : null;
  };

  const saveMessage = async (
    context: { userId: string; isTemporary?: boolean; expiredAt?: Date },
    message: DynamoItem,
  ): Promise<DynamoItem | undefined> => {
    const messageId = valueString(message.newMessageId) ?? valueString(message.messageId);
    const conversationId = valueString(message.conversationId);
    if (messageId == null || conversationId == null) {
      return undefined;
    }
    const current = await getMessage({ user: context.userId, messageId });
    const now = new Date().toISOString();
    const createdAt = valueString(current?.createdAt) ?? valueString(message.createdAt) ?? now;
    const sortKey = `MESSAGE#${createdAt}#${messageId}`;
    const next: DynamoItem = {
      ...(current ?? {}),
      ...toStoredItem(message),
      _id: valueString(current?._id) ?? messageId,
      messageId,
      conversationId,
      user: context.userId,
      createdAt,
      updatedAt: now,
      ...(context.isTemporary == null ? {} : { isTemporary: context.isTemporary }),
      ...(context.expiredAt == null
        ? {}
        : {
            expiredAt: context.expiredAt.toISOString(),
            expiresAt: Math.floor(context.expiredAt.getTime() / 1000),
          }),
    };
    delete next.newMessageId;
    const item: DynamoItem = { PK: `CONVERSATION#${conversationId}`, SK: sortKey, ...next };
    const locator: DynamoItem = {
      ...messageLocatorKey(messageId),
      conversationId,
      messageSortKey: sortKey,
    };
    assertItemSize(item);
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName,
              Item: item,
              ConditionExpression: 'attribute_not_exists(PK) OR #user = :user',
              ExpressionAttributeNames: { '#user': 'user' },
              ExpressionAttributeValues: { ':user': context.userId },
            },
          },
          {
            Put: {
              TableName,
              Item: locator,
              ConditionExpression: 'attribute_not_exists(PK) OR conversationId = :conversationId',
              ExpressionAttributeValues: { ':conversationId': conversationId },
            },
          },
        ],
      }),
    );
    return cleanItem(item);
  };

  const bulkSaveMessages = async (messages: DynamoItem[]): Promise<DynamoItem[]> =>
    (
      await Promise.all(
        messages.map((message) =>
          saveMessage({ userId: valueString(message.user) ?? '' }, message),
        ),
      )
    ).filter((message): message is DynamoItem => message != null);

  const recordMessage = async (message: DynamoItem): Promise<DynamoItem | undefined> =>
    saveMessage({ userId: valueString(message.user) ?? '' }, message);

  const updateMessage = async (userId: string, message: DynamoItem): Promise<DynamoItem> => {
    const messageId = valueString(message.messageId);
    if (messageId == null) {
      throw new TypeError('messageId is required');
    }
    const current = await getMessage({ user: userId, messageId });
    if (current == null) {
      throw new Error('Message not found or user not authorized.');
    }
    const updated = await saveMessage({ userId }, { ...current, ...message });
    if (updated == null) {
      throw new Error('Message not found or user not authorized.');
    }
    return updated;
  };

  const updateMessageText = async (
    userId: string,
    message: { messageId: string; text: string },
  ): Promise<void> => {
    await updateMessage(userId, message);
  };

  const messagesForConversation = async (conversationId: string): Promise<DynamoItem[]> => {
    const result = await queryAll({
      KeyConditionExpression: 'PK = :conversation AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':conversation': `CONVERSATION#${conversationId}`,
        ':prefix': 'MESSAGE#',
      },
      ScanIndexForward: true,
    });
    return result.items.map(cleanItem);
  };

  const getMessages = async (
    filter: DynamoFilter,
    select?: string,
    options: { sort?: false | { [key: string]: 1 | -1 }; limit?: number } = {},
  ): Promise<DynamoItem[]> => {
    const conversationId = valueString(filter.conversationId);
    const messageId = valueString(filter.messageId);
    let messages: DynamoItem[] = [];
    if (messageId != null) {
      const message = await getMessage({ user: valueString(filter.user) ?? '', messageId });
      messages = message == null ? [] : [message];
    } else if (conversationId != null) {
      messages = await messagesForConversation(conversationId);
    }
    const filtered = messages.filter((message) => matches(message, filter));
    const sorted =
      options.sort === false
        ? filtered
        : filtered.sort((left, right) =>
            String(left.createdAt).localeCompare(String(right.createdAt)),
          );
    const limited = options.limit == null ? sorted : sorted.slice(0, options.limit);
    return limited.map((message) => project(message, select) ?? message);
  };

  const getMessagesByCursor = async (
    filter: DynamoFilter,
    options: { sortOrder?: 1 | -1; limit?: number; cursor?: string | null; select?: string } = {},
  ): Promise<{ messages: DynamoItem[]; nextCursor: string | null }> => {
    const all = await getMessages(filter, options.select, { sort: false });
    const ordered = options.sortOrder === 1 ? all : all.reverse();
    const offset = options.cursor == null ? 0 : Number.parseInt(options.cursor, 10) || 0;
    const limit = options.limit ?? 25;
    return {
      messages: ordered.slice(offset, offset + limit),
      nextCursor: offset + limit < ordered.length ? String(offset + limit) : null,
    };
  };

  const deleteMessageRows = async (messages: DynamoItem[]): Promise<number> => {
    const requests = messages.flatMap((message) => {
      const messageId = valueString(message.messageId) ?? '';
      const conversationId = valueString(message.conversationId) ?? '';
      const createdAt = valueString(message.createdAt) ?? '';
      return [
        {
          DeleteRequest: {
            Key: { PK: `CONVERSATION#${conversationId}`, SK: `MESSAGE#${createdAt}#${messageId}` },
          },
        },
        { DeleteRequest: { Key: messageLocatorKey(messageId) } },
      ];
    });
    for (let offset = 0; offset < requests.length; offset += 24) {
      let pending = requests.slice(offset, offset + 24);
      while (pending.length > 0) {
        const result = await client.send(
          new BatchWriteCommand({ RequestItems: { [TableName]: pending } }),
        );
        pending = (result.UnprocessedItems?.[TableName] ?? []) as typeof pending;
      }
    }
    return messages.length;
  };

  const deleteMessages = async (filter: DynamoFilter): Promise<{ deletedCount: number }> => {
    const idsValue = filter.conversationId;
    const requestedIds = inValues(idsValue);
    let conversationIds =
      typeof idsValue === 'string'
        ? [idsValue]
        : (requestedIds?.filter((value): value is string => typeof value === 'string') ?? []);
    const userId = valueString(filter.user);
    if (conversationIds.length === 0 && userId != null) {
      const page = await getConvosByCursor(userId, { limit: 100 });
      conversationIds = page.conversations
        .map((conversation) => valueString(conversation.conversationId) ?? '')
        .filter(Boolean);
    }
    const rows = (
      await Promise.all(
        conversationIds.map((conversationId) => messagesForConversation(conversationId)),
      )
    )
      .flat()
      .filter((message) => matches(message, filter));
    return { deletedCount: await deleteMessageRows(rows) };
  };

  const deleteMessagesSince = async (
    userId: string,
    params: { messageId: string; conversationId: string },
  ): Promise<{ deletedCount: number } | undefined> => {
    const anchor = await getMessage({ user: userId, messageId: params.messageId });
    if (anchor == null) {
      return undefined;
    }
    const anchorCreatedAt = valueString(anchor.createdAt) ?? '';
    const rows = (await messagesForConversation(params.conversationId)).filter(
      (message) => message.user === userId && String(message.createdAt) > anchorCreatedAt,
    );
    return { deletedCount: await deleteMessageRows(rows) };
  };

  const deleteConvos = async (
    user: string,
    filter: DynamoFilter,
    options: { beforeDelete?: (ids: string[]) => Promise<void>; allowEmpty?: boolean } = {},
  ): Promise<{
    deletedCount: number;
    messages: { deletedCount: number };
    conversationIds: string[];
  }> => {
    const requested = filter.conversationId;
    let ids: string[] = [];
    if (typeof requested === 'string') {
      ids = [requested];
    } else if (inValues(requested) != null) {
      ids =
        inValues(requested)?.filter((value): value is string => typeof value === 'string') ?? [];
    } else {
      const page = await getConvosByCursor(user, { limit: 100 });
      ids = page.conversations
        .map((convo) => valueString(convo.conversationId) ?? '')
        .filter(Boolean);
    }
    const owned = (
      await Promise.all(ids.map((conversationId) => getConvo(user, conversationId)))
    ).filter((convo): convo is DynamoItem => convo != null && matches(convo, filter));
    const conversationIds = owned
      .map((convo) => valueString(convo.conversationId) ?? '')
      .filter(Boolean);
    if (conversationIds.length === 0 && !options.allowEmpty) {
      throw new Error('Conversation not found');
    }
    await options.beforeDelete?.(conversationIds);
    const deletedMessages = await deleteMessages({
      user,
      conversationId: { $in: conversationIds },
    });
    await Promise.all(
      conversationIds.map((conversationId) =>
        client.send(new DeleteCommand({ TableName, Key: convoKey(conversationId) })),
      ),
    );
    return { deletedCount: conversationIds.length, messages: deletedMessages, conversationIds };
  };

  const archiveAllConvos = async (user: string): Promise<{ archivedCount: number }> => {
    const page = await getConvosByCursor(user, { limit: 100, isArchived: false });
    await Promise.all(
      page.conversations.map((convo) =>
        saveConvo(
          { userId: user },
          {
            conversationId: valueString(convo.conversationId) ?? '',
            isArchived: true,
            archivedAt: new Date().toISOString(),
          },
          { noUpsert: true, preserveUpdatedAt: true },
        ),
      ),
    );
    return { archivedCount: page.conversations.length };
  };

  return {
    findUser,
    findUsers,
    countUsers,
    createUser,
    updateUser,
    getUserById,
    isAgentTriggerPrincipalActive,
    deleteUserById,
    generateToken,
    acceptTerms,
    updateUserPlugins,
    toggleUserMemories,
    updateUserStatefulCodeEnvironment,
    findSession,
    createSession,
    upsertSession,
    deleteSession,
    deleteAllUserSessions,
    updateExpiration,
    countActiveSessions,
    generateRefreshToken,
    ensureSessionIndexes,
    initializeRoles,
    seedDefaultRoles,
    seedSystemGrants,
    getRoleByName,
    findRolesByNames,
    updateRoleByName,
    updateAccessPermissions,
    searchConversation,
    getConvo,
    getConvoOwnership,
    getConvoRetention,
    getConvoFiles,
    getConvoTitle,
    saveConvo,
    setConvoPinned,
    getConvosByCursor,
    getConvosQueried,
    deleteConvos,
    archiveAllConvos,
    saveMessage,
    bulkSaveMessages,
    recordMessage,
    updateMessageText,
    updateMessage,
    getMessage,
    getMessages,
    getMessagesByCursor,
    deleteMessages,
    deleteMessagesSince,
  };
}
