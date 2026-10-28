import type { ScheduledMCPFailure } from './contract';

export const failureFixtures: Readonly<Record<ScheduledMCPFailure['reason'], ScheduledMCPFailure>> =
  {
    consent_missing: {
      reason: 'consent_missing',
      status: 'mcp_reauth_required',
      recovery: 'authorize',
      automaticReplay: false,
    },
    consent_expired: {
      reason: 'consent_expired',
      status: 'mcp_reauth_required',
      recovery: 'authorize',
      automaticReplay: false,
    },
    consent_revoked: {
      reason: 'consent_revoked',
      status: 'mcp_reauth_required',
      recovery: 'authorize',
      automaticReplay: false,
    },
    binding_mismatch: {
      reason: 'binding_mismatch',
      status: 'mcp_reauth_required',
      recovery: 'authorize',
      automaticReplay: false,
    },
    rbac_denied: {
      reason: 'rbac_denied',
      status: 'mcp_permission_denied',
      recovery: 'restore_permission',
      automaticReplay: false,
    },
    tool_policy_denied: {
      reason: 'tool_policy_denied',
      status: 'mcp_permission_denied',
      recovery: 'configure',
      automaticReplay: false,
    },
    approval_required: {
      reason: 'approval_required',
      status: 'mcp_permission_denied',
      recovery: 'configure',
      automaticReplay: false,
    },
    credential_missing: {
      reason: 'credential_missing',
      status: 'mcp_reauth_required',
      recovery: 'authorize',
      automaticReplay: false,
    },
    credential_rejected: {
      reason: 'credential_rejected',
      status: 'mcp_reauth_required',
      recovery: 'authorize',
      automaticReplay: false,
    },
    resource_permission_denied: {
      reason: 'resource_permission_denied',
      status: 'mcp_permission_denied',
      recovery: 'restore_permission',
      automaticReplay: false,
    },
    provider_missing: {
      reason: 'provider_missing',
      status: 'mcp_configuration_missing',
      recovery: 'configure',
      automaticReplay: false,
    },
    resource_unverified: {
      reason: 'resource_unverified',
      status: 'mcp_configuration_missing',
      recovery: 'configure',
      automaticReplay: false,
    },
    unsupported_mode: {
      reason: 'unsupported_mode',
      status: 'mcp_configuration_missing',
      recovery: 'configure',
      automaticReplay: false,
    },
    dependency_unavailable: {
      reason: 'dependency_unavailable',
      status: 'mcp_unavailable',
      recovery: 'retry_later',
      automaticReplay: false,
    },
  };
