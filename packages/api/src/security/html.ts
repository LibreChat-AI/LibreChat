const HTML_ATTRIBUTE_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text before interpolating it into a quoted HTML attribute. */
export function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ATTRIBUTE_ENTITIES[character]);
}
