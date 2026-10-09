import { logger } from '@librechat/data-schemas';
import type { mongo } from 'mongoose';

/**
 * Ensures that a collection exists in the database.
 * For DocumentDB compatibility, it tries multiple approaches.
 * @param db - The MongoDB database instance
 * @param collectionName - The name of the collection to ensure exists
 */
export async function ensureCollectionExists(db: mongo.Db, collectionName: string): Promise<void> {
  try {
    const collections = await db.listCollections({ name: collectionName }).toArray();
    if (collections.length === 0) {
      await db.createCollection(collectionName);
      logger.info(`Created collection: ${collectionName}`);
    } else {
      logger.debug(`Collection already exists: ${collectionName}`);
    }
  } catch (error) {
    logger.error(`Failed to check/create "${collectionName}" collection:`, error);
    // If listCollections fails, try alternative approach
    try {
      // Try to access the collection directly - this will create it in MongoDB if it doesn't exist
      await db.collection(collectionName).findOne({}, { projection: { _id: 1 } });
    } catch (createError) {
      logger.error(`Could not ensure collection ${collectionName} exists:`, createError);
    }
  }
}

/**
 * Ensures that all required collections exist for the permission system.
 * This includes aclentries, groups, accessroles, and any other collections
 * needed for migrations and permission checks.
 * @param db - The MongoDB database instance
 */
export async function ensureRequiredCollectionsExist(db: mongo.Db): Promise<void> {
  const requiredCollections = [
    'aclentries', // ACL permission entries
    'groups', // User groups
    'accessroles', // Access roles for permissions
    'agents', // Agents collection
    'promptgroups', // Prompt groups collection
    'projects', // Projects collection
    'chatprojects', // Private chat organization projects
  ];

  logger.debug('Ensuring required collections exist for permission system');

  for (const collectionName of requiredCollections) {
    await ensureCollectionExists(db, collectionName);
  }

  logger.debug('All required collections have been checked/created');
}
