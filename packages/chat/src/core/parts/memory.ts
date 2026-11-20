export type MemoryToolName = 'set_memory' | 'delete_memory';

export function isMemoryFailureOutput(toolName: MemoryToolName, output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) {
    return false;
  }
  return toolName === 'set_memory'
    ? !/^(?:Memory set for key|Memory saved\b)/i.test(trimmed)
    : !/^Memory deleted(?: for key|\.)/i.test(trimmed);
}
