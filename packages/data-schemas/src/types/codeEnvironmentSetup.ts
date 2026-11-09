export type CodeEnvironmentSetupBinding = {
  setupAttemptId: string;
  requestHash: string;
  ownerId: string;
  environmentId: string;
  name: string;
  type: 'managed' | 'attached';
  baseURL: string;
  controlPlaneId: string;
  workerId?: string;
  revocationTokenEnv?: string;
  workerPrincipal?: {
    type: 'deployment' | 'tenant' | 'user' | 'role' | 'group';
    id: string;
  };
};

export type CodeEnvironmentSetupRecord = {
  resourceId: string;
  id: string;
  name: string;
  type: 'managed' | 'attached';
  pending: boolean;
};
