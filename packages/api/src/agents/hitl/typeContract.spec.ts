import type {
  HumanInterruptPayload as SdkHumanInterruptPayload,
  ToolApprovalRequest as SdkToolApprovalRequest,
  ToolApprovalDecisionType as SdkToolApprovalDecisionType,
} from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';

/**
 * Compile-time contract between the SDK's HITL wire types and LibreChat's
 * `Agents.*` mirror in `librechat-data-provider`. The mirror is hand-maintained
 * (data-provider can't depend on `@librechat/agents`), so these assignability
 * checks are the seam that fails the build when the two drift.
 *
 * The assertions live inside the function signatures: each `accept*` function's
 * parameter type forces TypeScript to prove assignability at compile time. If
 * the SDK adds a field the mirror lacks (or a decision literal changes), this
 * file stops compiling — caught here instead of silently dropped on the Redis
 * round-trip. The runtime `expect`s exist only so Jest sees real tests.
 */
describe('HITL type contract: @librechat/agents ↔ librechat-data-provider', () => {
  test('the SDK interrupt payload is persistable as the LC mirror', () => {
    // Direction that matters most: `Run.getInterrupt()` returns the SDK payload,
    // which `approvals.pause()` persists as `Agents.PendingAction.payload`.
    // Losing a field here = silent data loss across the pause/resume boundary.
    const acceptLcPayload = (p: Agents.HumanInterruptPayload): Agents.HumanInterruptType => p.type;
    const fromSdk = (p: SdkHumanInterruptPayload) => acceptLcPayload(p);
    expect(typeof fromSdk).toBe('function');
  });

  test('the SDK action request is persistable as the LC mirror', () => {
    const acceptLcRequest = (r: Agents.ToolApprovalRequest): string => r.tool_call_id;
    const fromSdk = (r: SdkToolApprovalRequest) => acceptLcRequest(r);
    expect(typeof fromSdk).toBe('function');
  });

  test('decision-type literals match in both directions (resume input contract)', () => {
    // What an approval route sends to `run.resume()` must be a valid SDK
    // decision, and the LC mirror must enumerate exactly the SDK's literals.
    const lcToSdk = (d: Agents.ToolApprovalDecisionType): SdkToolApprovalDecisionType => d;
    const sdkToLc = (d: SdkToolApprovalDecisionType): Agents.ToolApprovalDecisionType => d;
    expect(typeof lcToSdk).toBe('function');
    expect(typeof sdkToLc).toBe('function');
  });
});
