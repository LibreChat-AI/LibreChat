export type TextEdit = {
  old_text: string;
  new_text: string;
  /** Replaces every location instead of requiring exactly one. */
  replace_all?: boolean;
};

/* Models often stringify nested JSON (JSON-in-JSON) instead of passing a
   real array/object, which would otherwise fail validation and cost a retry
   round-trip. Parse a JSON string back to its value; leave non-strings and
   unparseable strings untouched so the explicit errors below still fire. */
function coerceJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** `replace_all` as a boolean, tolerating the stringified form some models send. */
function normalizeReplaceAll(value: unknown): boolean | undefined | string {
  if (value === true || value === 'true') return true;
  if (value === undefined || value === null || value === false || value === 'false') {
    return undefined;
  }
  return 'replace_all must be true or false.';
}

function textEdit(oldText: string, newText: string, rawReplaceAll: unknown): TextEdit | string {
  if (oldText.length === 0) {
    return 'old_text cannot be empty.';
  }
  const replaceAll = normalizeReplaceAll(rawReplaceAll);
  if (typeof replaceAll === 'string') return replaceAll;
  return replaceAll
    ? { old_text: oldText, new_text: newText, replace_all: true }
    : { old_text: oldText, new_text: newText };
}

export function normalizeEditArgs(args: {
  old_text?: unknown;
  new_text?: unknown;
  replace_all?: unknown;
  edits?: unknown;
}): TextEdit[] | string {
  if (Object.prototype.hasOwnProperty.call(args, 'edits')) {
    const coercedEdits = coerceJsonValue(args.edits);
    if (!Array.isArray(coercedEdits) || coercedEdits.length === 0) {
      return 'Provide a non-empty edits array when edits is supplied.';
    }
    const edits: TextEdit[] = [];
    for (const rawEdit of coercedEdits) {
      const edit = coerceJsonValue(rawEdit);
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
        return 'Each edit must be an object with old_text and new_text.';
      }
      const entry = edit as { old_text?: unknown; new_text?: unknown; replace_all?: unknown };
      if (typeof entry.old_text !== 'string' || typeof entry.new_text !== 'string') {
        return 'Each edit requires string old_text and new_text.';
      }
      const normalized = textEdit(entry.old_text, entry.new_text, entry.replace_all);
      if (typeof normalized === 'string') return normalized;
      edits.push(normalized);
    }
    return edits;
  }

  if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string') {
    return 'Provide old_text and new_text, or a non-empty edits array.';
  }
  const normalized = textEdit(args.old_text, args.new_text, args.replace_all);
  return typeof normalized === 'string' ? normalized : [normalized];
}
