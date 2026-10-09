import { hasActivePiiFields } from 'librechat-data-provider';
import type { FiltersConfig } from 'librechat-data-provider';
import {
  getContentTraversalFragments,
  isContentTraversalLimitError,
  isContentTraversalProtected,
} from '../protection/adapters/nested';
import { extractToolArgumentContent } from '../protection/adapters/submissions';
import { ContentFilterError } from '../middleware/contentFilter';
import { inspectContent } from '../protection/runtime';

function assertToolOutputFragmentsAllowed(
  filters: FiltersConfig | undefined,
  fragments: ReturnType<typeof extractToolArgumentContent>,
): void {
  const finding = inspectContent(fragments, { filters });
  if (finding != null) {
    throw new ContentFilterError(finding);
  }
}

/** Enforces direct-call tool output before persistence or HTTP disclosure. */
export function assertDirectToolOutputAllowed(
  filters: FiltersConfig | undefined,
  toolId: string,
  output: unknown,
): void {
  if (!hasActivePiiFields(filters?.toolArguments?.pii, ['output'])) {
    return;
  }
  try {
    assertToolOutputFragmentsAllowed(filters, extractToolArgumentContent({ name: toolId, output }));
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    assertToolOutputFragmentsAllowed(filters, getContentTraversalFragments(error));
    if (isContentTraversalProtected({ error, filters })) {
      throw error;
    }
  }
}
