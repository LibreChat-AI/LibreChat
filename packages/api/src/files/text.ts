import axios from 'axios';
import FormData from 'form-data';
import { createReadStream } from 'fs';
import { logger } from '@librechat/data-schemas';
import { FileSources } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { logAxiosError, readFileAsString } from '~/utils';
import { getFileExtractionLogDetails } from './extract';
import { generateShortLivedToken } from '~/crypto/jwt';

const MARKDOWN_MIME_TYPES = new Set([
  'text/markdown',
  'text/x-markdown',
  'text/md',
  'application/markdown',
  'application/x-markdown',
]);

const MARKDOWN_EXTENSIONS_RE = /\.(md|markdown|mdown|mkdn|mkd|mdwn)$/i;

function normalizeMimeType(mimetype: string): string {
  if (!mimetype) {
    return '';
  }
  const semi = mimetype.indexOf(';');
  const base = semi === -1 ? mimetype : mimetype.slice(0, semi);
  return base.trim().toLowerCase();
}

function isMarkdownFile(file: Express.Multer.File): boolean {
  if (MARKDOWN_MIME_TYPES.has(normalizeMimeType(file.mimetype))) {
    return true;
  }
  return MARKDOWN_EXTENSIONS_RE.test(file.originalname ?? '');
}

/**
 * Attempts to parse text using RAG API, falls back to native text parsing.
 * @param params - The parameters object
 * @param params.req - The Express request object
 * @param params.file - The uploaded file
 * @param params.file_id - The file ID
 * @param params.allowNativeFallback - When false, throw instead of falling back to native parsing
 *   if the RAG API is unavailable. Callers handling document types (docx/pdf/etc.) set this so a
 *   RAG outage can be routed to the built-in document parser rather than degraded to raw bytes.
 * @returns
 */
export async function parseText({
  req,
  file,
  file_id,
  allowNativeFallback = true,
}: {
  req: ServerRequest;
  file: Express.Multer.File;
  file_id: string;
  allowNativeFallback?: boolean;
}): Promise<{ text: string; bytes: number; source: string }> {
  const getExtractionLogDetails = (error: unknown) =>
    getFileExtractionLogDetails({
      filters: req.config?.filters,
      filename: file.originalname,
      fileId: file_id,
      error,
    });
  const { contentProtected, fileLabel } = getExtractionLogDetails(undefined);
  const logRagError = (message: string, error: unknown): void => {
    if (!contentProtected) {
      logAxiosError({ message, error });
      return;
    }
    logger.error(message, getExtractionLogDetails(error).errorMetadata);
  };
  const nativeFallback = (): Promise<{ text: string; bytes: number; source: string }> => {
    if (!allowNativeFallback) {
      throw new Error(
        `[parseText] RAG text extraction unavailable for ${fileLabel} and native fallback is disabled`,
      );
    }
    return parseTextNative(file);
  };

  if (!process.env.RAG_API_URL) {
    logger.debug('[parseText] RAG_API_URL not defined');
    return nativeFallback();
  }

  if (isMarkdownFile(file)) {
    const markdownFileLabel = contentProtected ? fileLabel : file.originalname;
    logger.debug(
      `[parseText] Markdown file detected (${markdownFileLabel}, ${file.mimetype}), using native parsing to preserve raw formatting`,
    );
    return parseTextNative(file);
  }

  const userId = req.user?.id;
  if (!userId) {
    logger.debug('[parseText] No user ID provided');
    return nativeFallback();
  }

  try {
    const healthResponse = await axios.get(`${process.env.RAG_API_URL}/health`, {
      timeout: 10000,
    });
    if (healthResponse?.statusText !== 'OK' && healthResponse?.status !== 200) {
      logger.debug('[parseText] RAG API health check failed');
      return nativeFallback();
    }
  } catch (healthError) {
    logRagError('[parseText] RAG API health check failed:', healthError);
    return nativeFallback();
  }

  try {
    const jwtToken = generateShortLivedToken(userId);
    const formData = new FormData();
    formData.append('file_id', file_id);
    formData.append('file', createReadStream(file.path));

    const formHeaders = formData.getHeaders();

    const response = await axios.post(`${process.env.RAG_API_URL}/text`, formData, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        accept: 'application/json',
        ...formHeaders,
      },
      timeout: 300000,
    });

    const responseData = response.data;
    logger.debug(`[parseText] RAG API completed successfully (${response.status})`);

    if (!('text' in responseData)) {
      throw new Error('RAG API did not return parsed text');
    }

    return {
      text: responseData.text,
      bytes: Buffer.byteLength(responseData.text, 'utf8'),
      source: FileSources.text,
    };
  } catch (error) {
    logRagError('[parseText] RAG API text parsing failed', error);
    return nativeFallback();
  }
}

/**
 * Native JavaScript text parsing fallback
 * Simple text file reading - complex formats handled by RAG API
 * @param file - The uploaded file
 * @returns
 */
export async function parseTextNative(file: Express.Multer.File): Promise<{
  text: string;
  bytes: number;
  source: string;
}> {
  const { content: text, bytes } = await readFileAsString(file.path, {
    fileSize: file.size,
  });

  return {
    text,
    bytes,
    source: FileSources.text,
  };
}
