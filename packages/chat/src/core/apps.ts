import { Tools, isMcpAppMimeType } from 'librechat-data-provider';
import type { TAttachment, UIResource } from 'librechat-data-provider';

/**
 * An MCP App resource is server-bound and declares the MCP Apps HTML profile
 * (`text/html;profile=mcp-app`). Only these run the App Bridge handshake; plain `text/html`
 * resources are static and must render through a srcDoc iframe instead.
 */
export function isMcpAppResource(resource: UIResource): boolean {
  // Shared with the server's app-backed classification so the two sides cannot drift: a substring
  // test here accepted mime types the parser refuses to attach bridge fields to.
  return !!resource.toolName && !!resource.serverName && isMcpAppMimeType(resource.mimeType);
}

/**
 * Stable identity for a UI resource across re-renders. Keying render state by array index lets a
 * removed resource hand its loaded/torn-down state and measured height to whichever resource
 * reconciles onto its index.
 */
export function getResourceKey(resource: UIResource): string {
  return resource.resourceId || resource.uri;
}

/** One MCP App a tool call's attachment carries, with a key unique within the selection. */
export type MCPAppResourceOccurrence = {
  attachment: TAttachment;
  key: string;
  resource: UIResource;
};

const resourcesOf = (attachment: TAttachment): UIResource[] => {
  if (attachment.type !== Tools.ui_resources) {
    return [];
  }
  const value = attachment[Tools.ui_resources];
  return Array.isArray(value) ? (value as UIResource[]) : [];
};

/** Whether an attachment carries at least one MCP App. */
export function hasAppResource(attachment: TAttachment): boolean {
  return resourcesOf(attachment).some(isMcpAppResource);
}

/** MCP Apps owned by correlated attachment wrappers. Legacy HTML remains marker-owned. */
export function selectToolCallUIResources(attachments?: TAttachment[]): MCPAppResourceOccurrence[] {
  const occurrences = new Map<string, number>();
  return (attachments ?? []).flatMap((attachment) => {
    const owner = attachment as TAttachment & {
      toolCallId?: string;
      agentId?: string;
      stepId?: string;
    };
    return resourcesOf(attachment).flatMap((resource) => {
      if (!isMcpAppResource(resource)) {
        return [];
      }
      const semanticKey = JSON.stringify([
        owner.toolCallId,
        owner.agentId,
        owner.stepId,
        getResourceKey(resource),
      ]);
      const occurrence = occurrences.get(semanticKey) ?? 0;
      occurrences.set(semanticKey, occurrence + 1);
      return [{ attachment, key: JSON.stringify([semanticKey, occurrence]), resource }];
    });
  });
}
