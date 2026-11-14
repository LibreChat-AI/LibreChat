import { z } from 'zod';

type WithoutDefault<T> = T extends z.ZodDefault<infer I> | z.ZodPrefault<infer I> ? I : T;

export type PartialWithoutDefaultsShape<S extends z.core.$ZodShape> = {
  [K in keyof S]: z.ZodOptional<WithoutDefault<S[K]>>;
};

/**
 * `.partial()` that leaves omitted keys absent. Zod 4 runs a field's `.default()` even
 * inside `.optional()`, so a plain partial fills every unsent field with its default and
 * a partial update would overwrite stored values the caller never sent.
 */
export function partialWithoutDefaults<
  S extends z.core.$ZodShape,
  C extends z.core.$ZodObjectConfig,
>(schema: z.ZodObject<S, C>): z.ZodObject<PartialWithoutDefaultsShape<S>, C> {
  const shape: Record<string, z.core.$ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] =
      field instanceof z.ZodDefault || field instanceof z.ZodPrefault ? field.unwrap() : field;
  }
  return schema.extend(shape).partial() as unknown as z.ZodObject<
    PartialWithoutDefaultsShape<S>,
    C
  >;
}
