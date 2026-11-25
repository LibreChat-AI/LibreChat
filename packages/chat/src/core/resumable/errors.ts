const parseSSEErrorData = (body: string): unknown | null => {
  const blocks = body.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice('event:'.length)
      .trim();
    if (event !== 'error') {
      continue;
    }

    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
      .trim();

    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }

  return null;
};

const getSSEErrorText = (payload: unknown): string | null => {
  if (typeof payload === 'string') {
    return payload;
  }

  if (payload == null || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const text = record.text ?? record.message ?? record.error;
  return typeof text === 'string' && text.length > 0 ? text : null;
};

export const getStreamStartFailureText = (errorData?: unknown): string => {
  if (typeof errorData === 'string') {
    const sseErrorData = parseSSEErrorData(errorData);
    if (sseErrorData != null) {
      return getSSEErrorText(sseErrorData) ?? JSON.stringify(sseErrorData);
    }

    return errorData || 'Error connecting to server, try refreshing the page.';
  }

  return errorData
    ? JSON.stringify(errorData)
    : 'Error connecting to server, try refreshing the page.';
};
