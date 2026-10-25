/**
 * MongoDB's `DollarPrefixedFieldName`, `EmptyFieldName` and `DottedFieldName` server codes: a
 * field name the engine will not store. Current MongoDB stores dotted names and, from 5.0,
 * `$`-prefixed names inside values; older servers and MongoDB-compatible engines may still
 * reject them with these codes.
 */
const FIELD_NAME_ERROR_CODES = new Set<number>([52, 56, 57]);

/**
 * The storage-validation wording MongoDB uses ("... is not valid for storage", "contains an
 * empty field name") and the driver's client-side key check ("key a.b must not contain '.'"),
 * for engines that answer with a generic code.
 */
const FIELD_NAME_ERROR_MESSAGE =
  /not valid for storage|empty field name|field names? (?:cannot|can't|must not|may not)|must not (?:contain '\.'|start with '\$')/i;

/**
 * Whether a write failed because the database refused a field name in the document, such as a
 * dotted record key on an engine that cannot store one. The request carried a key this
 * deployment cannot hold, rather than hitting an outage, so the caller can answer with a
 * stable code instead of a generic failure.
 */
export function isFieldNameRejection(error: unknown): boolean {
  if (error == null || typeof error !== 'object') {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'number' && FIELD_NAME_ERROR_CODES.has(code)) {
    return true;
  }
  return typeof message === 'string' && FIELD_NAME_ERROR_MESSAGE.test(message);
}
