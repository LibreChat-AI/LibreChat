/**
 * Maps toolkit keys to additional tool names they contain.
 * When a toolkit key appears in an agent's tool list,
 * these extra tools should also be included.
 */
export const toolkitExpansion: {
  readonly image_gen_oai: readonly ['image_edit_oai'];
} = {
  image_gen_oai: ['image_edit_oai'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** Reverse mapping: maps child tool names to their parent toolkit key */
export const toolkitParent: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(toolkitExpansion).flatMap(([parent, children]) =>
    children.map((child) => [child, parent]),
  ),
);
