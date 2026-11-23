import { excelMimeTypes } from 'librechat-data-provider';
import {
  TextPaths,
  FilePaths,
  CodePaths,
  AudioPaths,
  VideoPaths,
  SheetPaths,
} from '@librechat/client';
import type { FC } from 'react';

/** How a file renders in an attachment card: the glyph, its fill role, and its kind's name. */
export type FileKind = {
  paths: FC;
  fillClassName: string;
  title: string;
};

export const partialTypes: string[] = ['text/x-'];

const textDocument = {
  paths: TextPaths,
  fillClassName: 'fill-file-document',
  title: 'Document',
};

const spreadsheet = {
  paths: SheetPaths,
  fillClassName: 'fill-file-sheet',
  title: 'Spreadsheet',
};

const codeFile = {
  paths: CodePaths,
  fillClassName: 'fill-file-code',
  // TODO: make this dynamic to the language
  title: 'Code',
};

const artifact = {
  paths: CodePaths,
  fillClassName: 'fill-file-artifact',
  title: 'Code',
};

const audioFile = {
  paths: AudioPaths,
  fillClassName: 'fill-file-audio',
  title: 'Audio',
};

const videoFile = {
  paths: VideoPaths,
  fillClassName: 'fill-file-video',
  title: 'Video',
};

export const fileTypes: Record<string, FileKind> = {
  /* Category matches */
  file: {
    paths: FilePaths,
    fillClassName: 'fill-file-generic',
    title: 'File',
  },
  text: textDocument,
  txt: textDocument,
  audio: audioFile,
  video: videoFile,
  // application:,

  /* Partial matches */
  csv: spreadsheet,
  'application/pdf': textDocument,
  pdf: textDocument,
  'text/x-': codeFile,
  artifact: artifact,

  /* Exact matches */
  // 'application/json':,
  // 'text/html':,
  // 'text/css':,
  // image,
};

export const getFileType = (type = ''): FileKind => {
  // Direct match check
  if (fileTypes[type]) {
    return fileTypes[type];
  }

  if (excelMimeTypes.test(type)) {
    return spreadsheet;
  }

  // Partial match check
  const partialMatch = partialTypes.find((partial) => type.includes(partial));
  if (partialMatch && fileTypes[partialMatch]) {
    return fileTypes[partialMatch];
  }

  // Category check
  const category = type.split('/')[0] || 'text';
  if (fileTypes[category]) {
    return fileTypes[category];
  }

  // Default file type
  return fileTypes.file;
};
