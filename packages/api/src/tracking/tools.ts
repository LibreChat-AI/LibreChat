import { isActionTool, productBuiltinToolNameSchema } from 'librechat-data-provider';
import type { ChatServerFact } from 'librechat-data-provider';
import { isMCPTool } from '~/tools/classification';

export type ProductToolIdentity = Pick<
  Extract<ChatServerFact, { name: 'librechat.chat.tool.invoked' }>,
  'toolCategory' | 'toolName'
>;

/** Call only for a host-owned operation or a provider's typed built-in step. */
export function getProductBuiltinToolIdentity(name: string): ProductToolIdentity {
  const parsed = productBuiltinToolNameSchema.safeParse(name);
  return parsed.success
    ? { toolCategory: 'builtin', toolName: parsed.data }
    : { toolCategory: 'custom' };
}

/** Classify the resolved tool, never its arguments or an arbitrary function-call name. */
export function getProductToolIdentity(
  tool: { name: string; mcp?: boolean } | undefined,
): ProductToolIdentity {
  if (!tool) return { toolCategory: 'custom' };
  if (isMCPTool(tool)) return { toolCategory: 'mcp' };
  if (isActionTool(tool.name)) return { toolCategory: 'action' };
  return getProductBuiltinToolIdentity(tool.name);
}
