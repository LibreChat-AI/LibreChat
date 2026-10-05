import { logger, decrypt } from '@librechat/data-schemas';
import type { IPluginAuth, PluginAuthMethods } from '@librechat/data-schemas';
import { getSafeErrorMetadata } from '~/utils/errors';

export interface GetPluginAuthMapParams {
  userId: string;
  pluginKeys: string[];
  throwError?: boolean;
  findPluginAuthsByKeys: PluginAuthMethods['findPluginAuthsByKeys'];
}

export type PluginAuthMap = Record<string, Record<string, string>>;

/**
 * Retrieves and decrypts authentication values for multiple plugins
 * @returns A map where keys are pluginKeys and values are objects of authField:decryptedValue pairs
 */
export async function getPluginAuthMap({
  userId,
  pluginKeys,
  throwError = true,
  findPluginAuthsByKeys,
}: GetPluginAuthMapParams): Promise<PluginAuthMap> {
  try {
    /** Early return for empty plugin keys */
    if (!pluginKeys?.length) {
      return {};
    }

    /** All plugin auths for current user query */
    const pluginAuths = await findPluginAuthsByKeys({ userId, pluginKeys });

    /** Group auth records by pluginKey for efficient lookup */
    const authsByPlugin = new Map<string, IPluginAuth[]>();
    for (const auth of pluginAuths) {
      if (!auth.pluginKey) {
        logger.warn(`[getPluginAuthMap] Missing pluginKey for userId ${userId}`);
        continue;
      }
      const existing = authsByPlugin.get(auth.pluginKey) || [];
      existing.push(auth);
      authsByPlugin.set(auth.pluginKey, existing);
    }

    const authMap: PluginAuthMap = {};
    const decryptionPromises: Promise<void>[] = [];

    /** Single loop through requested pluginKeys */
    for (const pluginKey of pluginKeys) {
      authMap[pluginKey] = {};
      const auths = authsByPlugin.get(pluginKey) || [];

      for (const auth of auths) {
        decryptionPromises.push(
          (async () => {
            try {
              const decryptedValue = await decrypt(auth.value);
              authMap[pluginKey][auth.authField] = decryptedValue;
            } catch (error) {
              logger.error('[getPluginAuthMap] Decryption failed', getSafeErrorMetadata(error));

              if (throwError) {
                throw new Error(
                  `Decryption failed for plugin ${pluginKey}, field ${auth.authField}`,
                  { cause: error },
                );
              }
            }
          })(),
        );
      }
    }

    await Promise.all(decryptionPromises);
    return authMap;
  } catch (error) {
    logger.warn('[getPluginAuthMap] Failed to fetch auth values', getSafeErrorMetadata(error));
    if (!throwError) {
      /** Empty objects for each plugin key on error */
      return pluginKeys.reduce((acc, key) => {
        acc[key] = {};
        return acc;
      }, {} as PluginAuthMap);
    }
    throw error;
  }
}
