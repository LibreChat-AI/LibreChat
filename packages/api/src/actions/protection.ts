import {
  ACTION_METADATA_FILTER_FIELDS,
  hasActivePiiFields,
  type FiltersConfig,
} from 'librechat-data-provider';
import type { Response } from 'express';
import type { AssistantActionContentInput } from '../protection/adapters/submissions';
import { extractAssistantActionContent } from '../protection/adapters/submissions';
import { contentFilterBlockResponse } from '../middleware/contentFilter';
import { inspectContentWithTraversal } from '../protection/runtime';

/** Enforces the exact action projection before it is returned or persisted. */
export function blockFilteredActionProjection(
  filters: FiltersConfig | undefined,
  res: Response,
  action: AssistantActionContentInput,
): boolean {
  const needsInspection =
    hasActivePiiFields(filters?.agentInstructions?.pii, ['name', 'description']) ||
    hasActivePiiFields(filters?.toolArguments?.pii, ['name', 'arguments']) ||
    hasActivePiiFields(filters?.actionMetadata?.pii, ACTION_METADATA_FILTER_FIELDS);
  if (!needsInspection) {
    return false;
  }
  const { finding, traversalError } = inspectContentWithTraversal(
    () => extractAssistantActionContent(action),
    { filters },
  );
  if (finding != null) {
    res.status(400).json(contentFilterBlockResponse(finding));
    return true;
  }
  if (traversalError != null) {
    res.status(traversalError.statusCode).json(traversalError.body);
    return true;
  }
  return false;
}
