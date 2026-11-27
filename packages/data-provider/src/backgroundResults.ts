/** Shared serialized metadata shape for admission budgeting and continuation rendering. */
export function backgroundResultMetadata(result: {
  taskId: string;
  toolCallId: string;
  toolName: string;
  status: 'completed' | 'error' | 'cancelled';
}) {
  return {
    background_task_id: result.taskId,
    tool_call_id: result.toolCallId,
    tool: result.toolName,
    status: result.status,
    result: '',
  };
}
