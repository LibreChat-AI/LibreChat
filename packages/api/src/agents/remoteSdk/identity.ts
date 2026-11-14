export interface SdkAgentIdentity {
  readonly agentId: string;
  readonly runtimeId: string;
  readonly runId: string;
  readonly conversationId?: string;
  readonly userId: string;
  readonly tenantId?: string;
}
