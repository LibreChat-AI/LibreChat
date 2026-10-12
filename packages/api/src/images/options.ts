import { sanitizeImageChoice } from 'librechat-data-provider';
import type { TImageChoice, TImageOptions, TImageSpec } from 'librechat-data-provider';
import type { ExtendedJsonSchema } from '~/tools/registry/schema';
import { geminiToolkit } from '~/tools/toolkits/gemini';
import { oaiToolkit } from '~/tools/toolkits/oai';
import { resolveImageSpec } from './specs';

/**
 * Per tool, which argument each `TImageOptions` list governs. A tool argument
 * missing here (`quality`, `background`) is one no measured model honoured,
 * so a spec that declares `options` drops it from the schema altogether.
 */
const governed: Record<string, Partial<Record<keyof TImageChoice, keyof TImageOptions>>> = {
  [oaiToolkit.image_gen_oai.name]: { size: 'sizes' },
  [oaiToolkit.image_edit_oai.name]: { size: 'sizes' },
  [geminiToolkit.gemini_image_gen.name]: { aspectRatio: 'aspectRatios', imageSize: 'imageSizes' },
};

/** Arguments a spec with `options` can never pass on: no model it lists honours them. */
const ungoverned: Record<string, string[]> = {
  [oaiToolkit.image_gen_oai.name]: ['quality', 'background'],
  [oaiToolkit.image_edit_oai.name]: ['quality'],
  [geminiToolkit.gemini_image_gen.name]: [],
};

/** The OpenAI tools' `size` also takes `auto`, which leaves the size to the model. */
const allowedValues = (toolName: string, field: keyof TImageChoice, list: string[]): string[] =>
  field === 'size' && toolName !== geminiToolkit.gemini_image_gen.name ? ['auto', ...list] : list;

/** The user's pinned choice for `spec`, limited to what the entry offers. */
export function resolveImageChoice(
  spec: TImageSpec | undefined,
  raw: unknown,
): TImageChoice | undefined {
  return sanitizeImageChoice(spec?.options, raw);
}

/**
 * The tool schema the chat model should see for `spec`: enums cut down to the
 * values the image model honours, and anything the user pinned removed, since
 * the tool overrides it either way and offering it only invites a conflict.
 *
 * A spec without `options` keeps the generic schema apart from pinned fields.
 */
export function imageToolSchema(
  toolName: string,
  base: ExtendedJsonSchema,
  spec: TImageSpec | undefined,
  choice: TImageChoice | undefined,
): ExtendedJsonSchema {
  const fields = governed[toolName];
  if (fields == null || base.properties == null) {
    return base;
  }
  const options = spec?.options;
  const properties: Record<string, ExtendedJsonSchema> = { ...base.properties };

  for (const [field, listKey] of Object.entries(fields) as [
    keyof TImageChoice,
    keyof TImageOptions,
  ][]) {
    if (properties[field] == null) {
      continue;
    }
    if (choice?.[field] != null) {
      delete properties[field];
      continue;
    }
    if (options == null) {
      continue;
    }
    const list = options[listKey];
    if (list == null || list.length === 0) {
      delete properties[field];
      continue;
    }
    const { pattern: _pattern, ...rest } = properties[field];
    properties[field] = { ...rest, enum: allowedValues(toolName, field, list) };
  }

  if (options != null) {
    for (const field of ungoverned[toolName] ?? []) {
      delete properties[field];
    }
  }

  return { ...base, properties };
}

/**
 * The arguments the image tool actually sends: the user's pinned values win,
 * and a value the chat model chose that the spec does not list is dropped so
 * the provider default applies instead of an error or a silent mismatch.
 */
export function applyImageChoice<T extends Record<string, unknown>>(
  toolName: string,
  args: T,
  spec: TImageSpec | undefined,
  choice: TImageChoice | undefined,
): T {
  const fields = governed[toolName];
  if (fields == null) {
    return args;
  }
  const options = spec?.options;
  const next: Record<string, unknown> = { ...args };

  for (const [field, listKey] of Object.entries(fields) as [
    keyof TImageChoice,
    keyof TImageOptions,
  ][]) {
    const pinned = choice?.[field];
    if (pinned != null) {
      next[field] = pinned;
      continue;
    }
    if (options == null || next[field] == null) {
      continue;
    }
    const allowed = allowedValues(toolName, field, options[listKey] ?? []);
    if (!allowed.includes(String(next[field]))) {
      delete next[field];
    }
  }

  if (options != null) {
    for (const field of ungoverned[toolName] ?? []) {
      delete next[field];
    }
  }

  return next as T;
}

/**
 * Narrowed schemas for the image tools a request equips, keyed by tool name,
 * for the definitions the chat model sees. Empty when the request carries no
 * Image Gen selection: a saved agent's own image tools keep the stock schema.
 */
export function imageToolSchemasFor(
  ephemeralAgent: { image_gen?: boolean | string; image_options?: unknown } | null | undefined,
  imageList: TImageSpec[] | undefined,
): Record<string, ExtendedJsonSchema> {
  const resolved = resolveImageSpec(ephemeralAgent?.image_gen, imageList);
  if (resolved?.spec == null) {
    return {};
  }
  const choice = resolveImageChoice(resolved.spec, ephemeralAgent?.image_options);
  const toolNames =
    resolved.toolName === geminiToolkit.gemini_image_gen.name
      ? [geminiToolkit.gemini_image_gen]
      : [oaiToolkit.image_gen_oai, oaiToolkit.image_edit_oai];
  return Object.fromEntries(
    toolNames.map((tool) => [
      tool.name,
      imageToolSchema(tool.name, tool.schema, resolved.spec, choice),
    ]),
  );
}

/**
 * Makes `imageTool` send the arguments `applyImageChoice` settles on, by
 * wrapping the function LangChain invokes. Wrapping rather than editing the
 * tool bodies keeps those upstream files to a one-line change.
 */
export function bindImageChoice<
  T extends { name: string; func: (args: Record<string, unknown>, ...rest: never[]) => unknown },
>(imageTool: T, spec: TImageSpec | undefined, choice: TImageChoice | undefined): T {
  const invoke = imageTool.func.bind(imageTool);
  imageTool.func = ((args: Record<string, unknown>, ...rest: never[]) =>
    invoke(applyImageChoice(imageTool.name, args, spec, choice), ...rest)) as T['func'];
  return imageTool;
}
