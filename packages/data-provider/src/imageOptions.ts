import { z } from 'zod';

/**
 * The image parameters an `imageList` entry honours, as measured through the
 * gateway rather than as the provider documents them: a relay can accept a
 * field and ignore it, so only values that changed the output belong here.
 *
 * Absent means unknown, and the tools keep their generic schema. An empty
 * object means the model honours none of them, so the tools offer none.
 */
export const tImageOptionsSchema = z.object({
  /** `/v1/images/*` `size` values, `WIDTHxHEIGHT`. OpenAI protocol only. */
  sizes: z.array(z.string().regex(/^[1-9][0-9]*x[1-9][0-9]*$/)).optional(),
  /** `imageConfig.aspectRatio` values such as `16:9`. Gemini protocol only. */
  aspectRatios: z.array(z.string().regex(/^[1-9][0-9]*:[1-9][0-9]*$/)).optional(),
  /** `imageConfig.imageSize` values such as `2K`. Gemini protocol only. */
  imageSizes: z.array(z.string()).optional(),
});

export type TImageOptions = z.infer<typeof tImageOptionsSchema>;

/**
 * What the user pinned for the selected image model, sent as
 * `ephemeralAgent.image_options`. A pinned field overrides the chat model's
 * tool argument; an unset one leaves the choice to the chat model.
 */
export interface TImageChoice {
  size?: string;
  aspectRatio?: string;
  imageSize?: string;
}

export const imageChoiceKeys = {
  size: 'sizes',
  aspectRatio: 'aspectRatios',
  imageSize: 'imageSizes',
} as const satisfies Record<keyof TImageChoice, keyof TImageOptions>;

/**
 * Keeps only the choices `options` allows. The choice comes from the client
 * and can outlive a config change, so anything the entry no longer offers is
 * dropped rather than sent to a model that would reject or ignore it.
 */
export function sanitizeImageChoice(
  options: TImageOptions | undefined,
  raw: unknown,
): TImageChoice | undefined {
  if (options == null || raw == null || typeof raw !== 'object') {
    return undefined;
  }
  const choice: TImageChoice = {};
  for (const [field, listKey] of Object.entries(imageChoiceKeys) as [
    keyof TImageChoice,
    keyof TImageOptions,
  ][]) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'string' && options[listKey]?.includes(value) === true) {
      choice[field] = value;
    }
  }
  return Object.keys(choice).length > 0 ? choice : undefined;
}
