const bindingKey: unique symbol = Symbol.for('librechat.toolApprovalBinding');
const nameKey: unique symbol = Symbol.for('librechat.toolApprovalName');
type BoundTool = { [bindingKey]?: string; [nameKey]?: string };

/** Object spreads retain the binding; JSON/provider payloads cannot expose it. */
export function bindToolApproval<T extends object>(
  tool: T,
  binding: string | undefined,
  name?: string,
): T {
  if (binding != null) (tool as BoundTool)[bindingKey] = binding;
  if (name != null) (tool as BoundTool)[nameKey] = name;
  return tool;
}

export function getToolApprovalBinding(tool: object): string | undefined {
  return (tool as BoundTool)[bindingKey];
}

export function getToolApprovalName(tool: object): string | undefined {
  return (tool as BoundTool)[nameKey];
}
