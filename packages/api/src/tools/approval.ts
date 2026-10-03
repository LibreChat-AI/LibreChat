const bindingKey: unique symbol = Symbol.for('librechat.toolApprovalBinding');
type BoundTool = { [bindingKey]?: string };

/** Object spreads retain the binding; JSON/provider payloads cannot expose it. */
export function bindToolApproval<T extends object>(tool: T, binding: string | undefined): T {
  if (binding != null) (tool as BoundTool)[bindingKey] = binding;
  return tool;
}

export function getToolApprovalBinding(tool: object): string | undefined {
  return (tool as BoundTool)[bindingKey];
}
