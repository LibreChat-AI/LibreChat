/** Strips the runtime index suffix from saved or ephemeral agent IDs. */
export function stripAgentIdSuffix(agentId: string): string {
  return agentId.replace(/____\d+$/, '');
}

/** Distinguishes parallel runtime nodes without changing the saved agent identity. */
export function appendAgentIdSuffix(agentId: string, index: number): string {
  return `${agentId}____${index}`;
}
