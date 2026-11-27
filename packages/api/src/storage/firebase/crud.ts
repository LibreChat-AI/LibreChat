import fs from 'fs';
import path from 'path';
import { logger } from '@librechat/data-schemas';
import { ref, uploadBytes, deleteObject, getDownloadURL } from 'firebase/storage';
import type { FirebaseStorage } from 'firebase/storage';
import type { SaveBufferParams, UploadFileParams, UploadResult } from '~/storage/types';
import type { StoredObjectRef } from '~/storage/discard';
import { getSafeErrorMetadata } from '~/utils/errors';

const defaultBasePath = 'images';

export interface FirebaseUploadDeps {
  /** Resolves the configured storage instance, or null when Firebase is not set up. */
  getStorage: () => FirebaseStorage | null;
}

export interface FirebaseUploads {
  getFirebaseURL(params: { fileName: string; basePath?: string }): Promise<string | null>;
  saveBufferToFirebase(params: SaveBufferParams): Promise<string | null>;
  uploadFileToFirebase(params: UploadFileParams): Promise<UploadResult>;
  deleteFirebaseObject(params: StoredObjectRef): Promise<void>;
}

/** Builds the Firebase upload helpers around a caller-supplied storage resolver. */
export function createFirebaseUploads({ getStorage }: FirebaseUploadDeps): FirebaseUploads {
  /**
   * Resolves the download URL of `${basePath}/${fileName}`.
   * Returns null when Firebase is not initialized or the lookup fails.
   */
  async function getFirebaseURL({
    fileName,
    basePath = defaultBasePath,
  }: {
    fileName: string;
    basePath?: string;
  }): Promise<string | null> {
    const storage = getStorage();
    if (!storage) {
      logger.error('Firebase is not initialized. Cannot get image URL from Firebase Storage.');
      return null;
    }

    const storageRef = ref(storage, `${basePath}/${fileName}`);

    try {
      return await getDownloadURL(storageRef);
    } catch (error) {
      logger.error('Error fetching file URL from Firebase Storage:', (error as Error).message);
      return null;
    }
  }

  /** Uploads a buffer to `${basePath}/${userId}/${fileName}` and returns its download URL. */
  async function saveBufferToFirebase({
    userId,
    buffer,
    fileName,
    basePath = defaultBasePath,
  }: SaveBufferParams): Promise<string | null> {
    const storage = getStorage();
    if (!storage) {
      throw new Error('Firebase is not initialized');
    }

    const storageRef = ref(storage, `${basePath}/${userId}/${fileName}`);
    await uploadBytes(storageRef, buffer);

    return await getFirebaseURL({ fileName, basePath: `${basePath}/${userId}` });
  }

  /**
   * Best-effort delete of `${basePath}/${userId}/${fileName}`, for an object that was stored
   * but has no download URL (so no file record can point at it). Failures are logged, never thrown.
   */
  async function deleteFirebaseObject({
    userId,
    fileName,
    basePath = defaultBasePath,
  }: StoredObjectRef): Promise<void> {
    const storage = getStorage();
    if (!storage) {
      return;
    }

    try {
      await deleteObject(ref(storage, `${basePath}/${userId}/${fileName}`));
    } catch (error) {
      logger.warn('[deleteFirebaseObject] Could not delete the unreferenced Firebase object', {
        ...getSafeErrorMetadata(error),
      });
    }
  }

  /**
   * Uploads a multer temp file under the caller's `basePath` (`images` when omitted).
   * On failure the temp file is removed and the error is rethrown.
   */
  async function uploadFileToFirebase({
    req,
    file,
    file_id,
    basePath = defaultBasePath,
  }: UploadFileParams): Promise<UploadResult> {
    if (!req.user) {
      throw new Error('[uploadFileToFirebase] User not authenticated');
    }

    const inputFilePath = file.path;
    const inputBuffer = await fs.promises.readFile(inputFilePath);
    const bytes = Buffer.byteLength(inputBuffer);
    const userId = req.user.id;
    const fileName = `${file_id}__${path.basename(inputFilePath)}`;
    try {
      const downloadURL = await saveBufferToFirebase({
        userId,
        buffer: inputBuffer,
        fileName,
        basePath,
      });
      if (!downloadURL) {
        await deleteFirebaseObject({ userId, fileName, basePath });
        throw new Error('[uploadFileToFirebase] Firebase returned no download URL');
      }
      return { filepath: downloadURL, bytes };
    } catch (err) {
      logger.error('[uploadFileToFirebase] Error saving file buffer to Firebase:', err);
      try {
        if (file && file.path) {
          await fs.promises.unlink(file.path);
        }
      } catch (unlinkError) {
        logger.error(
          '[uploadFileToFirebase] Error deleting temporary file, likely already deleted:',
          (unlinkError as Error).message,
        );
      }
      throw err;
    }
  }

  return { getFirebaseURL, saveBufferToFirebase, uploadFileToFirebase, deleteFirebaseObject };
}
