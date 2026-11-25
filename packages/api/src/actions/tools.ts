import { actionDelimiter, validateAndParseOpenAPISpec } from 'librechat-data-provider';

export { normalizeActionToolName } from 'librechat-data-provider';

export type ActionToolLike = {
  function?: {
    name?: string;
  };
};

export type MergeAgentActionToolsParams = {
  existingTools: string[];
  incomingFunctions: ActionToolLike[];
  encodedDomain: string;
  actionId: string;
  requestedActionId?: string;
  legacyDomain?: string;
  previousEncodedDomain?: string;
  previousLegacyDomain?: string;
  previousRawSpec?: string;
};

const httpMethods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sanitizeOperationId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '');
}

function getFunctionNames(functions: ActionToolLike[]): string[] {
  const names = new Set<string>();

  for (const tool of functions) {
    const name = tool.function?.name;
    if (typeof name === 'string' && name.length > 0) {
      names.add(name);
    }
  }

  return [...names];
}

function getSpecOperationNames(rawSpec?: string): string[] {
  if (!rawSpec) {
    return [];
  }

  const result = validateAndParseOpenAPISpec(rawSpec);
  if (!result.status || !isRecord(result.spec?.paths)) {
    return [];
  }

  const names = new Set<string>();
  for (const [path, methods] of Object.entries(result.spec.paths)) {
    if (!isRecord(methods)) {
      continue;
    }

    for (const [method, operation] of Object.entries(methods)) {
      if (!httpMethods.has(method.toLowerCase()) || !isRecord(operation)) {
        continue;
      }

      const operationId = operation.operationId;
      names.add(
        typeof operationId === 'string' && operationId.length > 0
          ? operationId
          : sanitizeOperationId(`${method}_${path}`),
      );
    }
  }

  return [...names];
}

function getUniqueValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

export function mergeAgentActionTools({
  existingTools,
  incomingFunctions,
  encodedDomain,
  actionId,
  requestedActionId,
  legacyDomain,
  previousEncodedDomain,
  previousLegacyDomain,
  previousRawSpec,
}: MergeAgentActionToolsParams): string[] {
  const incomingNames = getFunctionNames(incomingFunctions);
  const domainsToReplace = getUniqueValues([
    encodedDomain,
    legacyDomain,
    previousEncodedDomain,
    previousLegacyDomain,
  ]);
  const namesToReplace = getUniqueValues([
    ...incomingNames,
    ...getSpecOperationNames(previousRawSpec),
  ]);
  const toolsToReplace = new Set<string>();

  for (const name of namesToReplace) {
    for (const domain of domainsToReplace) {
      toolsToReplace.add(`${name}${actionDelimiter}${domain}`);
    }
  }

  const actionIdsToReplace = getUniqueValues([actionId, requestedActionId]);
  const retainedTools = existingTools.filter((tool) => {
    if (!tool) {
      return false;
    }

    if (toolsToReplace.has(tool)) {
      return false;
    }

    return !actionIdsToReplace.some((id) => tool.includes(id));
  });

  return retainedTools.concat(
    incomingNames.map((name) => `${name}${actionDelimiter}${encodedDomain}`),
  );
}
