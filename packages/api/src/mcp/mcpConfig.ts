import { math, isEnabled } from '~/utils';

const oauthHandlingTimeout = math(process.env.MCP_OAUTH_HANDLING_TIMEOUT ?? 10 * 60 * 1000);
/** Grace so flow state outlives the handling wait rather than expiring at the same instant —
 * covers callback processing, the monitor poll interval, and multi-replica clock skew. */
const OAUTH_FLOW_TTL_GRACE_MS = 60 * 1000;
/** Flow state must outlive the handling wait, otherwise a callback arriving near the
 * deadline cannot find its flow. Clamp the configured TTL above the handling timeout. */
const oauthFlowTtl = Math.max(
  math(process.env.MCP_OAUTH_FLOW_TTL ?? 15 * 60 * 1000),
  oauthHandlingTimeout + OAUTH_FLOW_TTL_GRACE_MS,
);

/**
 * Centralized configuration for MCP-related environment variables.
 * Provides typed access to MCP settings with default values.
 */
export const mcpConfig: {
  OAUTH_ON_AUTH_ERROR: boolean;
  OAUTH_DETECTION_TIMEOUT: number;
  /** How long (ms) to wait for the user to complete an OAuth flow before timing out. Default: 10 minutes */
  OAUTH_HANDLING_TIMEOUT: number;
  /** TTL (ms) for OAuth flow state. Must outlive OAUTH_HANDLING_TIMEOUT so the state survives the wait. Default: 15 minutes */
  OAUTH_FLOW_TTL: number;
  CONNECTION_CHECK_TTL: number;
  /** Max number of `tools/list` pages to request when an MCP server paginates its tool list.
   * Bounds the pagination loop so a misbehaving server cannot stall tool discovery. Default: 50 */
  TOOLS_LIST_MAX_PAGES: number;
  /** Max total tools to retain from paginated `tools/list` responses. Default: 1000 */
  TOOLS_LIST_MAX_TOOLS: number;
  /** Max approximate JSON bytes to retain from paginated `tools/list` responses. Default: 5 MiB */
  TOOLS_LIST_MAX_BYTES: number;
  /** Max elapsed time (ms) for paginated `tools/list` discovery. Default: 30000 */
  TOOLS_LIST_TIMEOUT_MS: number;
  /** Idle timeout (ms) after which user connections are disconnected. Default: 15 minutes */
  USER_CONNECTION_IDLE_TIMEOUT: number;
  /** Max connect/disconnect cycles before the circuit breaker trips. Default: 7 */
  CB_MAX_CYCLES: number;
  /** Sliding window (ms) for counting cycles. Default: 45s */
  CB_CYCLE_WINDOW_MS: number;
  /** Cooldown (ms) after the cycle breaker trips. Default: 15s */
  CB_CYCLE_COOLDOWN_MS: number;
  /** Max consecutive failed connection rounds before backoff. Default: 3 */
  CB_MAX_FAILED_ROUNDS: number;
  /** Sliding window (ms) for counting failed rounds. Default: 120s */
  CB_FAILED_WINDOW_MS: number;
  /** Base backoff (ms) after failed round threshold is reached. Default: 30s */
  CB_BASE_BACKOFF_MS: number;
  /** Max backoff cap (ms) for exponential backoff. Default: 300s */
  CB_MAX_BACKOFF_MS: number;
} = {
  OAUTH_ON_AUTH_ERROR: isEnabled(process.env.MCP_OAUTH_ON_AUTH_ERROR ?? true),
  OAUTH_DETECTION_TIMEOUT: math(process.env.MCP_OAUTH_DETECTION_TIMEOUT ?? 5000),
  /** How long (ms) to wait for the user to complete an OAuth flow before timing out. Default: 10 minutes */
  OAUTH_HANDLING_TIMEOUT: oauthHandlingTimeout,
  /** TTL (ms) for OAuth flow state. Clamped to never fall below OAUTH_HANDLING_TIMEOUT. Default: 15 minutes */
  OAUTH_FLOW_TTL: oauthFlowTtl,
  CONNECTION_CHECK_TTL: math(process.env.MCP_CONNECTION_CHECK_TTL ?? 60000),
  /** Max number of `tools/list` pages to request when an MCP server paginates its tool list. Clamped to >= 1. Default: 50 */
  TOOLS_LIST_MAX_PAGES: Math.max(1, math(process.env.MCP_TOOLS_LIST_MAX_PAGES ?? 50)),
  /** Max total tools to retain from paginated `tools/list` responses. Clamped to >= 1. Default: 1000 */
  TOOLS_LIST_MAX_TOOLS: Math.max(1, math(process.env.MCP_TOOLS_LIST_MAX_TOOLS ?? 1000)),
  /** Max approximate JSON bytes to retain from paginated `tools/list` responses. Clamped to >= 1. Default: 5 MiB */
  TOOLS_LIST_MAX_BYTES: Math.max(1, math(process.env.MCP_TOOLS_LIST_MAX_BYTES ?? 5 * 1024 * 1024)),
  /** Max elapsed time (ms) for paginated `tools/list` discovery. Clamped to >= 1. Default: 30000 */
  TOOLS_LIST_TIMEOUT_MS: Math.max(1, math(process.env.MCP_TOOLS_LIST_TIMEOUT_MS ?? 30_000)),
  /** Idle timeout (ms) after which user connections are disconnected. Default: 15 minutes */
  USER_CONNECTION_IDLE_TIMEOUT: math(
    process.env.MCP_USER_CONNECTION_IDLE_TIMEOUT ?? 15 * 60 * 1000,
  ),
  /** Max connect/disconnect cycles before the circuit breaker trips. Default: 7 */
  CB_MAX_CYCLES: math(process.env.MCP_CB_MAX_CYCLES ?? 7),
  /** Sliding window (ms) for counting cycles. Default: 45s */
  CB_CYCLE_WINDOW_MS: math(process.env.MCP_CB_CYCLE_WINDOW_MS ?? 45_000),
  /** Cooldown (ms) after the cycle breaker trips. Default: 15s */
  CB_CYCLE_COOLDOWN_MS: math(process.env.MCP_CB_CYCLE_COOLDOWN_MS ?? 15_000),
  /** Max consecutive failed connection rounds before backoff. Default: 3 */
  CB_MAX_FAILED_ROUNDS: math(process.env.MCP_CB_MAX_FAILED_ROUNDS ?? 3),
  /** Sliding window (ms) for counting failed rounds. Default: 120s */
  CB_FAILED_WINDOW_MS: math(process.env.MCP_CB_FAILED_WINDOW_MS ?? 120_000),
  /** Base backoff (ms) after failed round threshold is reached. Default: 30s */
  CB_BASE_BACKOFF_MS: math(process.env.MCP_CB_BASE_BACKOFF_MS ?? 30_000),
  /** Max backoff cap (ms) for exponential backoff. Default: 300s */
  CB_MAX_BACKOFF_MS: math(process.env.MCP_CB_MAX_BACKOFF_MS ?? 300_000),
};
