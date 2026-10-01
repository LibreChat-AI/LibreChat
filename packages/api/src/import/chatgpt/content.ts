import type { ChatGptMessage, ChatGptPart, ImportedAsset } from '~/import/types';

export type ContentPart = { type: 'text'; text: string };

/**
 * One asset reference found on a message, carrying the dimensions the export
 * records inline on `image_asset_pointer` parts. Generated (`sediment://`)
 * images never appear in `metadata.attachments`, so this is the only source
 * of their width/height.
 */
export interface AssetReference {
  pointer: string;
  width?: number;
  height?: number;
}

function referenceOf(part: ChatGptPart): AssetReference | null {
  if (typeof part === 'string') {
    return null;
  }
  if (part.content_type === 'real_time_user_audio_video_asset_pointer') {
    const pointer = part.audio_asset_pointer?.asset_pointer;
    return pointer ? { pointer } : null;
  }
  if (part.content_type === 'image_asset_pointer') {
    return typeof part.asset_pointer === 'string' && part.asset_pointer.trim().length > 0
      ? { pointer: part.asset_pointer, width: part.width, height: part.height }
      : null;
  }
  if (part.content_type === 'audio_asset_pointer') {
    return typeof part.asset_pointer === 'string' && part.asset_pointer.trim().length > 0
      ? { pointer: part.asset_pointer }
      : null;
  }
  return null;
}

export function collectAssetReferences(message: ChatGptMessage): AssetReference[] {
  const parts = message.content.parts;
  if (!parts) {
    return [];
  }

  const references: AssetReference[] = [];
  for (const part of parts) {
    const reference = referenceOf(part);
    if (reference) {
      references.push(reference);
    }
  }
  return references;
}

export function collectAssetPointers(message: ChatGptMessage): string[] {
  return collectAssetReferences(message).map((reference) => reference.pointer);
}

function convertPart(
  part: ChatGptPart,
  assets: Map<string, ImportedAsset>,
  parts: ContentPart[],
  texts: string[],
  files: ImportedAsset[],
): void {
  if (typeof part === 'string') {
    if (part.length > 0) {
      parts.push({ type: 'text', text: part });
      texts.push(part);
    }
    return;
  }

  if (part.content_type === 'audio_transcription') {
    if (part.text.length > 0) {
      parts.push({ type: 'text', text: part.text });
      texts.push(part.text);
    }
    return;
  }

  const reference = referenceOf(part);
  if (!reference) {
    return;
  }

  const asset = assets.get(reference.pointer);
  if (!asset) {
    return;
  }

  files.push(asset);
}

export function convertContent(
  message: ChatGptMessage,
  assets: Map<string, ImportedAsset>,
): { text: string; parts: ContentPart[]; files: ImportedAsset[] } {
  const { content } = message;

  if (content.content_type === 'code') {
    const text = `\`\`\`${content.language ?? ''}\n${content.text ?? ''}\n\`\`\``;
    return { text, parts: [{ type: 'text', text }], files: [] };
  }

  if (content.content_type === 'execution_output') {
    const text = `Execution Output:\n> ${content.text ?? ''}`;
    return { text, parts: [{ type: 'text', text }], files: [] };
  }

  /**
   * `tether_browsing_display` and `tether_quote` carry no `parts` at all: the
   * payload sits in `result`, `text`, or `content`. `isEmitted` still saves
   * these messages, so returning empty here rendered them as blank bubbles and
   * lost every browsed page and quotation in the export.
   */
  if (!content.parts) {
    const text = content.result ?? content.text ?? content.content ?? '';
    return text
      ? { text, parts: [{ type: 'text', text }], files: [] }
      : { text: '', parts: [], files: [] };
  }

  const parts: ContentPart[] = [];
  const texts: string[] = [];
  const files: ImportedAsset[] = [];
  for (const part of content.parts) {
    convertPart(part, assets, parts, texts, files);
  }

  return { text: texts.join('\n\n'), parts, files };
}
