import type { ClientSession } from 'mongoose';
import type { Types } from 'mongoose';
import type {
  AgentApiKeyCreateResult,
  AgentApiKeyCreateData,
  AgentApiKeyListItem,
  IAgentApiKey,
  AgentApiKeyBinding,
} from '~/types';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { prepareChannelOwnerAdmission } from './channelOwner';
import { createChannelIndexGate } from './channelIndexes';
import { hashToken, getRandomValues } from '~/crypto';
import logger from '~/config/winston';

const API_KEY_PREFIX = 'sk-';
const API_KEY_LENGTH = 32;

async function keyDigest(key: string, bound: boolean): Promise<string> {
  const digest = await hashToken(bound ? `bound:${key}` : key);
  // Legacy validators produce only hex digests, even for attacker-chosen wrappers.
  return bound ? `bound-v1:${digest}` : digest;
}

export function createAgentApiKeyMethods(mongoose: typeof import('mongoose')): {
  createAgentApiKey: (data: AgentApiKeyCreateData) => Promise<AgentApiKeyCreateResult>;
  validateAgentApiKey: (apiKey: string) => Promise<{
    userId: Types.ObjectId;
    keyId: Types.ObjectId;
    binding?: AgentApiKeyBinding;
  } | null>;
  listAgentApiKeys: (userId: string | Types.ObjectId) => Promise<AgentApiKeyListItem[]>;
  deleteAgentApiKey: (
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ) => Promise<boolean>;
  deleteAllAgentApiKeys: (userId: string | Types.ObjectId) => Promise<number>;
  getAgentApiKeyById: (
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ) => Promise<AgentApiKeyListItem | null>;
} {
  const ensureBoundKeyIndexes = createChannelIndexGate(() => [mongoose.models.AgentApiKey]);
  async function generateApiKey(
    bound: boolean,
  ): Promise<{ key: string; keyHash: string; keyPrefix: string }> {
    const randomPart = await getRandomValues(API_KEY_LENGTH);
    const key = `${bound ? 'sk-bound-' : API_KEY_PREFIX}${randomPart}`;
    const keyHash = await keyDigest(key, bound);
    const keyPrefix = key.slice(0, bound ? 16 : 8);
    return { key, keyHash, keyPrefix };
  }

  async function createAgentApiKey(data: AgentApiKeyCreateData): Promise<AgentApiKeyCreateResult> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const { key, keyHash, keyPrefix } = await generateApiKey(data.binding != null);

      let tenantId = getTenantId();
      if (data.binding && tenantId === SYSTEM_TENANT_ID) {
        const owner = await mongoose.models.User.findById(data.userId).select('tenantId').lean();
        if (!owner) throw new Error('Bound-key owner unavailable');
        tenantId = owner.tenantId || undefined;
      }
      const record = {
        userId: data.userId,
        name: data.name,
        keyHash,
        keyPrefix,
        expiresAt: data.expiresAt || undefined,
        ...(data.binding ? { binding: data.binding } : {}),
        ...(data.binding && tenantId ? { tenantId } : {}),
      };
      const persist = async (session?: ClientSession): Promise<IAgentApiKey> => {
        const [created] = await AgentApiKey.create([record], session ? { session } : {});
        return created;
      };
      let apiKeyDoc: IAgentApiKey;
      if (data.binding) {
        await ensureBoundKeyIndexes();
        const admit = await prepareChannelOwnerAdmission(mongoose, {
          userId: String(data.userId),
          tenantId,
        });
        const session = await mongoose.startSession();
        try {
          const created = await session.withTransaction(async () => {
            if (!(await admit(session))) throw new Error('Bound-key owner unavailable');
            return persist(session);
          });
          if (!created) throw new Error('Bound-key write did not commit');
          apiKeyDoc = created;
        } finally {
          await session.endSession();
        }
      } else apiKeyDoc = await persist();

      return {
        id: String(apiKeyDoc._id),
        name: apiKeyDoc.name,
        keyPrefix,
        key,
        createdAt: apiKeyDoc.createdAt,
        expiresAt: apiKeyDoc.expiresAt,
      };
    } catch (error) {
      logger.error('[createAgentApiKey] Error creating API key:', error);
      throw error;
    }
  }

  async function validateAgentApiKey(apiKey: string): Promise<{
    userId: Types.ObjectId;
    keyId: Types.ObjectId;
    binding?: AgentApiKeyBinding;
  } | null> {
    const AgentApiKey = mongoose.models.AgentApiKey;
    const keyHash = await keyDigest(apiKey, apiKey.startsWith('sk-bound-'));

    const keyDoc = (await AgentApiKey.findOne({ keyHash }).lean()) as IAgentApiKey | null;

    if (!keyDoc) {
      return null;
    }
    if (apiKey.startsWith('sk-bound-') !== (keyDoc.binding != null)) return null;

    if (keyDoc.expiresAt && new Date(keyDoc.expiresAt) < new Date()) {
      return null;
    }

    AgentApiKey.updateOne({ _id: keyDoc._id }, { $set: { lastUsedAt: new Date() } }).catch(
      (error: unknown) => {
        logger.error('[validateAgentApiKey] Error updating lastUsedAt:', error);
      },
    );

    return {
      userId: keyDoc.userId,
      keyId: keyDoc._id as Types.ObjectId,
      ...(keyDoc.binding ? { binding: keyDoc.binding } : {}),
    };
  }

  async function listAgentApiKeys(userId: string | Types.ObjectId): Promise<AgentApiKeyListItem[]> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const keys = (await AgentApiKey.find({ userId })
        .sort({ createdAt: -1 })
        .lean()) as unknown as IAgentApiKey[];

      return keys.map((key) => ({
        id: (key._id as Types.ObjectId).toString(),
        name: key.name,
        keyPrefix: key.keyPrefix,
        lastUsedAt: key.lastUsedAt,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
      }));
    } catch (error) {
      logger.error('[listAgentApiKeys] Error listing API keys:', error);
      throw error;
    }
  }

  async function deleteAgentApiKey(
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ): Promise<boolean> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const result = await AgentApiKey.deleteOne({ _id: keyId, userId });
      return result.deletedCount > 0;
    } catch (error) {
      logger.error('[deleteAgentApiKey] Error deleting API key:', error);
      throw error;
    }
  }

  async function deleteAllAgentApiKeys(userId: string | Types.ObjectId): Promise<number> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const result = await AgentApiKey.deleteMany({ userId });
      return result.deletedCount;
    } catch (error) {
      logger.error('[deleteAllAgentApiKeys] Error deleting all API keys:', error);
      throw error;
    }
  }

  async function getAgentApiKeyById(
    keyId: string | Types.ObjectId,
    userId: string | Types.ObjectId,
  ): Promise<AgentApiKeyListItem | null> {
    try {
      const AgentApiKey = mongoose.models.AgentApiKey;
      const keyDoc = (await AgentApiKey.findOne({
        _id: keyId,
        userId,
      }).lean()) as IAgentApiKey | null;

      if (!keyDoc) {
        return null;
      }

      return {
        id: (keyDoc._id as Types.ObjectId).toString(),
        name: keyDoc.name,
        keyPrefix: keyDoc.keyPrefix,
        lastUsedAt: keyDoc.lastUsedAt,
        expiresAt: keyDoc.expiresAt,
        createdAt: keyDoc.createdAt,
        ...(keyDoc.binding ? { binding: keyDoc.binding } : {}),
      };
    } catch (error) {
      logger.error('[getAgentApiKeyById] Error getting API key:', error);
      throw error;
    }
  }

  return {
    createAgentApiKey,
    validateAgentApiKey,
    listAgentApiKeys,
    deleteAgentApiKey,
    deleteAllAgentApiKeys,
    getAgentApiKeyById,
  };
}

export type AgentApiKeyMethods = ReturnType<typeof createAgentApiKeyMethods>;
