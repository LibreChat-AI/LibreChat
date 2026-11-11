import { logger } from '@librechat/data-schemas';
import type { PullRequestProvider } from 'librechat-data-provider';
import type { PullRequestErrorCode } from './types';

/** Provider responses cannot prove whether a comparison failed due to access or missing commits. */
type DiscoveryReason = PullRequestErrorCode | 'COMPARISON_UNAVAILABLE' | 'COMPARISON_LIMIT';

/** Only bounded codes leave discovery here, never credentials, repository identity or payloads. */
export function logDiscoveryDiagnostic(
  provider: PullRequestProvider,
  reason: DiscoveryReason,
): void {
  logger.debug('[PullRequests] Discovery diagnostic', { provider, reason });
}
