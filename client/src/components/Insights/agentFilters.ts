export function clearAgentFilters(searchParams: URLSearchParams): URLSearchParams {
  const nextParams = new URLSearchParams(searchParams);
  nextParams.delete('agentIds');
  return nextParams;
}

export function shouldRecoverAgentFilters(status: number | undefined, agentIds: string[]): boolean {
  return status === 403 && agentIds.length > 0;
}
