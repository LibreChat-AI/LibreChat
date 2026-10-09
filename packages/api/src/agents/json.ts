export const AGENT_ENVELOPE_MAX_NESTING_DEPTH = 64;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type ErrorFactory = (message: string) => Error;

export function cloneJsonValue<T>(
  value: T,
  path: string,
  createError: ErrorFactory,
  ancestors: WeakSet<object> = new WeakSet(),
  depth = 0,
): T {
  if (depth > AGENT_ENVELOPE_MAX_NESTING_DEPTH) {
    throw createError(
      `${path} exceeds the maximum nesting depth of ${AGENT_ENVELOPE_MAX_NESTING_DEPTH}`,
    );
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw createError(`${path} must contain only finite numbers`);
    }
    return value;
  }

  if (typeof value !== 'object') {
    throw createError(`${path} contains a non-JSON ${typeof value} value`);
  }

  if (ancestors.has(value)) {
    throw createError(`${path} contains a circular reference`);
  }

  ancestors.add(value);

  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw createError(`${path} contains symbol keys`);
    }

    if (Array.isArray(value)) {
      const cloned: unknown[] = new Array(value.length);
      let clonedItemCount = 0;
      for (const key of Object.getOwnPropertyNames(value)) {
        if (key === 'length') {
          continue;
        }
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= value.length ||
          String(index) !== key
        ) {
          throw createError(`${path} contains non-index array properties`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw createError(`${path}[${index}] must not be an accessor property`);
        }
        const itemValue: unknown = descriptor.value;
        cloned[index] = cloneJsonValue(
          itemValue,
          `${path}[${index}]`,
          createError,
          ancestors,
          depth + 1,
        );
        clonedItemCount++;
      }
      if (clonedItemCount !== value.length) {
        throw createError(`${path} contains sparse array entries`);
      }
      return cloned as T;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw createError(`${path} contains a non-plain object value`);
    }

    const cloned: { [key: string]: unknown } = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true) {
        throw createError(`${path}.${key} must be an enumerable property`);
      }
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw createError(`${path}.${key} must not be an accessor property`);
      }
      const propertyValue: unknown = descriptor.value;
      Object.defineProperty(cloned, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneJsonValue(propertyValue, `${path}.${key}`, createError, ancestors, depth + 1),
      });
    }
    return cloned as T;
  } finally {
    ancestors.delete(value);
  }
}
