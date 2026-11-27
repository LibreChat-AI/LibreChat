const SAFE_EXCEPTION_MESSAGE = 'Error details withheld';

export interface SafeSpanException {
  message: string;
  name: string;
}

const TRUSTED_ERROR_TYPES = new Map<object, string>([
  [Error.prototype, 'Error'],
  [EvalError.prototype, 'EvalError'],
  [RangeError.prototype, 'RangeError'],
  [ReferenceError.prototype, 'ReferenceError'],
  [SyntaxError.prototype, 'SyntaxError'],
  [TypeError.prototype, 'TypeError'],
  [URIError.prototype, 'URIError'],
]);

function getErrorConstructorName(error: Error): string {
  try {
    return TRUSTED_ERROR_TYPES.get(Object.getPrototypeOf(error) as object) ?? 'Error';
  } catch {
    return 'Error';
  }
}

export function getErrorType(error: unknown): string {
  try {
    if (error instanceof Error) {
      return getErrorConstructorName(error);
    }
  } catch {
    return 'object';
  }

  if (error === null) {
    return 'null';
  }

  return typeof error;
}

export function getSafeSpanException(error: unknown): SafeSpanException {
  return {
    message: SAFE_EXCEPTION_MESSAGE,
    name: getErrorType(error),
  };
}
