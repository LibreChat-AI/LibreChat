import { Constants, normalizeServerName } from 'librechat-data-provider';
import type { ToolApprovalAuthKind } from 'librechat-data-provider';
import type { MCPToolReviewAuthorityInput } from '~/mcp/approval';
import type { AgentApprovalDefinition } from './modes';
import { buildMCPToolReviewAuthority, getMCPToolApprovalAuthKind } from '~/mcp/approval';
import { buildMCPToolApprovalBinding, attachMCPToolApprovalBindings } from './modes';
import { bindToolApproval, bindToolApprovalIdentity } from '~/tools/approval';
import { normalizeJsonSchema, resolveJsonSchemaRefs } from '~/mcp/zod';
import { createSafeUser } from '~/utils/env';

interface MetadataInput extends Omit<MCPToolReviewAuthorityInput, 'user'> {
  user?: Parameters<typeof createSafeUser>[0];
}
interface InstanceMetadataInput extends MetadataInput {
  upstreamName: string;
  currentToolName?: string;
  parameters?: Record<string, unknown>;
  description?: string;
}
interface ApprovalMetadata {
  binding?: string;
  authority?: string;
  authKind?: ToolApprovalAuthKind;
}
export interface MCPToolApprovalMetadata {
  capture: (input: MetadataInput) => void;
  attach: (definitions: AgentApprovalDefinition[]) => void;
  bindInstance: <T extends AgentApprovalDefinition>(tool: T, input: InstanceMetadataInput) => T;
}

/** One request-local owner for runtime and definitions-only approval provenance. */
export function createMCPToolApprovalMetadata(): MCPToolApprovalMetadata {
  const bindings = new Map<string, string | undefined>();
  const authorities = new Map<string, string | undefined>();
  const authKinds = new Map<string, ToolApprovalAuthKind | undefined>();
  const project = (input: MetadataInput): ApprovalMetadata => ({
    binding: buildMCPToolApprovalBinding(input.serverName, input.config),
    authority: buildMCPToolReviewAuthority({ ...input, user: createSafeUser(input.user) }),
    authKind: getMCPToolApprovalAuthKind(input.config),
  });
  return {
    capture(input) {
      const metadata = project(input);
      bindings.set(input.serverName, metadata.binding);
      authorities.set(input.serverName, metadata.authority);
      authKinds.set(input.serverName, metadata.authKind);
    },
    attach(definitions) {
      attachMCPToolApprovalBindings(definitions, bindings, authorities, authKinds);
    },
    bindInstance(tool, input) {
      const metadata = project(input);
      const canonicalName =
        input.currentToolName == null
          ? tool.name
          : `${input.currentToolName}${Constants.mcp_delimiter}${normalizeServerName(input.serverName)}`;
      bindToolApproval(
        tool,
        metadata.binding,
        canonicalName,
        undefined,
        metadata.authority,
        metadata.authKind,
      );
      return bindToolApprovalIdentity(
        tool,
        input.upstreamName,
        normalizeJsonSchema(
          resolveJsonSchemaRefs(input.parameters ?? { type: 'object', properties: {} }),
        ),
        input.description || undefined,
      );
    },
  };
}
