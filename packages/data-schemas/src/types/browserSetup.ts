export type BrowserSetupStatus =
  | 'pending'
  | 'provisioning'
  | 'approved'
  | 'completing'
  | 'completed'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'failed';

export type BrowserSetupApproval = {
  protocolVersion: 1;
  operation: 'enrollment.redeem';
  serverId: string;
  instance: string;
  attemptId: string;
  requestHash: string;
  workerId: string;
  expiresAt: string;
  publicKey: string;
  binding: { tenantId: string; principal: { type: 'user'; id: string } };
};

export type BrowserSetupProgress = {
  registryReserved?: boolean;
  registryCompleted?: boolean;
  issued?: boolean;
  redemption?: boolean;
  cleanup?: boolean;
};

export type BrowserSetupSession = {
  attemptId: string;
  requestCanonical: string;
  requestHash: string;
  createdAt: string;
  expiresAt: string;
  verificationCode: string;
  workerId: string;
  status: BrowserSetupStatus;
  revision: number;
  ownerId?: string;
  tenantId?: string;
  planeId?: string;
  baseURL?: string;
  tokenEnv?: string;
  approval?: BrowserSetupApproval;
  progress?: BrowserSetupProgress;
  failureCode?: string;
  stopReason?: 'denied' | 'cancelled' | 'expired' | 'withdrawn';
  leaseId?: string;
  leaseExpiresAt?: number;
  purgeAt?: string;
};

export type BrowserSetupPatch = Partial<
  Pick<
    BrowserSetupSession,
    | 'status'
    | 'ownerId'
    | 'tenantId'
    | 'planeId'
    | 'baseURL'
    | 'tokenEnv'
    | 'approval'
    | 'progress'
    | 'failureCode'
    | 'stopReason'
    | 'purgeAt'
  >
>;

export type BrowserSetupStartResult =
  | { status: 'created'; session: BrowserSetupSession }
  | { status: 'replay'; session: BrowserSetupSession }
  | { status: 'conflict' }
  | { status: 'limited' };

export type BrowserSetupNonceResult = 'claimed' | 'replay' | 'limited' | 'missing';

export type BrowserSetupBudgetLimits = { global: number; perIp: number; windowMs: number };

export type BrowserSetupStore = {
  consumeRequest: (input: {
    ipHash: string;
    now: number;
    limits: BrowserSetupBudgetLimits;
  }) => Promise<boolean>;
  claim: (input: {
    attemptId: string;
    requestHash: string;
    revision: number;
    leaseId: string;
    now: number;
    leaseMs: number;
  }) => Promise<BrowserSetupSession | null>;
  release: (input: {
    attemptId: string;
    requestHash: string;
    revision: number;
    leaseId: string;
  }) => Promise<BrowserSetupSession | null>;
  listReconcile: (limit: number, now?: number) => Promise<BrowserSetupSession[]>;
  start: (input: {
    session: BrowserSetupSession;
    ipHash: string;
    now: number;
    limits: BrowserSetupBudgetLimits;
  }) => Promise<BrowserSetupStartResult>;
  get: (attemptId: string) => Promise<BrowserSetupSession | null>;
  update: (input: {
    attemptId: string;
    requestHash: string;
    revision: number;
    patch: BrowserSetupPatch;
    leaseId?: string;
  }) => Promise<BrowserSetupSession | null>;
  claimNonce: (input: {
    attemptId: string;
    requestHash: string;
    nonce: string;
    now: number;
    expiresAt: number;
    maxNonces: number;
    maxOperations: number;
  }) => Promise<BrowserSetupNonceResult>;
};

export type BrowserSetupUser = {
  id: string;
  tenantId?: string;
  role?: string;
  idOnTheSource?: string | null;
  provider?: string;
  emailVerified?: boolean;
  twoFactorEnabled?: boolean;
  termsAccepted?: boolean;
  agentTriggerDeletionStartedAt?: Date | null;
  expiresAt?: Date;
};

export type BrowserSetupBackend = {
  createStore: () => BrowserSetupStore;
  ensureRegistration: () => Promise<void>;
  getUser: (id: string) => Promise<BrowserSetupUser | null>;
  isConnected: () => boolean;
};
