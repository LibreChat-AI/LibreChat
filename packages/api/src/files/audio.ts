import fs from 'fs';
import { logger } from '@librechat/data-schemas';
import type {
  AudioProcessingResult,
  ServerRequest,
  AudioFileInfo,
  STTService,
  FileObject,
} from '~/types';
import { getBlockedUninspectableFileField, UninspectableFileError } from '~/protection/files';
import { getSafeErrorMetadata } from '~/utils';

/**
 * Processes audio files using Speech-to-Text (STT) service.
 * @returns A promise that resolves to an object containing text and bytes.
 */
export async function processAudioFile({
  req,
  file,
  sttService,
}: {
  req: ServerRequest;
  file: FileObject;
  sttService: STTService;
}): Promise<AudioProcessingResult> {
  const uninspectableField = getBlockedUninspectableFileField(req.config?.filters, ['transcript']);
  let text: string;
  try {
    const audioBuffer = await fs.promises.readFile(file.path);
    const audioFile: AudioFileInfo = {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    };

    const [provider, sttSchema, allowedAddresses] = await sttService.getProviderSchema(req);
    text = await sttService.sttRequest(
      provider,
      sttSchema,
      { audioBuffer, audioFile },
      allowedAddresses,
    );
  } catch (error) {
    logger.error('Error processing audio file with STT:', getSafeErrorMetadata(error));
    if (uninspectableField != null) {
      throw new UninspectableFileError(uninspectableField);
    }
    throw new Error(`Failed to process audio file: ${(error as Error).message}`);
  }

  if (text.trim().length === 0 && uninspectableField != null) {
    throw new UninspectableFileError(uninspectableField);
  }
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}
