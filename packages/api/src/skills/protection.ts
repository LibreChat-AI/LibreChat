import { hasActivePiiFields, type FiltersConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import {
  getBlockedUninspectableSkillFileField,
  hasActiveFileFieldPolicy,
  UninspectableFileError,
} from '../protection/files';
import { extractFileContent, extractSkillContent } from '../protection/adapters/submissions';
import { ContentFilterError, isContentFilterError } from '../middleware/contentFilter';
import { inspectContent } from '../protection/runtime';
import { isBinaryBuffer } from './binary';

export interface SkillFileContentPolicyInput {
  readonly buffer: Buffer;
  readonly originalName: string;
  readonly relativePath: string;
}

/** Enforces both skill-file and canonical file policy over one uploaded buffer. */
export function assertSkillFileContentAllowed(
  filters: FiltersConfig | undefined,
  input: SkillFileContentPolicyInput,
): void {
  const inspectSkillNames = hasActivePiiFields(filters?.skills?.pii, ['file_name']);
  const inspectSkillText = hasActivePiiFields(filters?.skills?.pii, ['file_text']);
  const inspectFileNames = hasActiveFileFieldPolicy(filters, ['name']);
  const inspectFileText = hasActiveFileFieldPolicy(filters, ['content', 'extracted_text']);
  const inspectText = inspectSkillText || inspectFileText;
  if (!inspectSkillNames && !inspectFileNames && !inspectText) {
    return;
  }
  const isBinary = inspectText && isBinaryBuffer(input.buffer);
  if (isBinary) {
    const blockedField = getBlockedUninspectableSkillFileField(filters, [
      'content',
      'extracted_text',
    ]);
    if (blockedField != null) {
      throw new UninspectableFileError(blockedField);
    }
  }
  const text = inspectText && !isBinary ? input.buffer.toString('utf8') : undefined;
  const finding = inspectContent(
    [
      ...(inspectSkillNames || inspectSkillText
        ? extractSkillContent({
            files: [
              ...(inspectSkillNames ? [{ filename: input.originalName }] : []),
              {
                ...(inspectSkillNames ? { filename: input.relativePath } : {}),
                ...(inspectSkillText ? { text } : {}),
              },
            ],
          })
        : []),
      ...(inspectFileNames || inspectFileText
        ? extractFileContent({
            ...(inspectFileNames
              ? { originalname: input.originalName, name: input.relativePath }
              : {}),
            ...(inspectFileText ? { content: text, text } : {}),
          })
        : []),
    ],
    { filters },
  );
  if (finding != null) {
    throw new ContentFilterError(finding);
  }
}

/** Express adapter shared by live skill-file mutation routes. */
export function blockFilteredSkillFile(
  filters: FiltersConfig | undefined,
  res: Response,
  input: SkillFileContentPolicyInput,
): boolean {
  try {
    assertSkillFileContentAllowed(filters, input);
    return false;
  } catch (error) {
    if (!isContentFilterError(error)) {
      throw error;
    }
    res.status(error.statusCode).json(error.body);
    return true;
  }
}
