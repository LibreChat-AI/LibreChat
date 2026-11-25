/** Providers whose signed deliveries a connection can stand for. */
export const connectionProviders = ['github'] as const;
export type ConnectionProvider = (typeof connectionProviders)[number];

/** `suspended` is the provider's own hold on an install; a removed install has no record. */
export const connectionStatuses = ['active', 'suspended'] as const;
export type ConnectionStatus = (typeof connectionStatuses)[number];

/**
 * One install of a provider's app, bound to the tenant its events run in. It holds no secret:
 * the app's credentials belong to the deployment.
 */
export interface Connection {
  id: string;
  tenantId?: string;
  provider: ConnectionProvider;
  /** The provider's own id for this install. */
  installation: string;
  /** The provider-side account the app is installed on. */
  account: { id: string; name: string };
  status: ConnectionStatus;
  /** The user who bound the install. */
  createdBy: string;
}

/** A connection as its picker shows it: nothing of the install beyond its account and state. */
export interface ConnectionChoice {
  id: string;
  provider: ConnectionProvider;
  /** The provider-side account the app is installed on, by name. */
  account: string;
  status: ConnectionStatus;
}

export interface ConnectionChoicesResponse {
  connections: ConnectionChoice[];
}

/** Stable codes an admin connection request can fail with; a UI maps each to its own copy. */
export const ConnectionError = {
  invalid: 'CONNECTION_INVALID',
  state: 'CONNECTION_STATE_INVALID',
  code: 'CONNECTION_CODE_INVALID',
  inaccessible: 'CONNECTION_NOT_ACCESSIBLE',
  missing: 'CONNECTION_NOT_FOUND',
  installation: 'CONNECTION_INSTALLATION_NOT_FOUND',
  taken: 'CONNECTION_TAKEN',
  unconfigured: 'CONNECTION_NOT_CONFIGURED',
  refused: 'CONNECTION_APP_REFUSED',
  unavailable: 'CONNECTION_GITHUB_UNAVAILABLE',
  audit: 'CONNECTION_AUDIT_UNAVAILABLE',
} as const;
export type ConnectionErrorCode = (typeof ConnectionError)[keyof typeof ConnectionError];

/** A connection as the admin API describes it: everything but the tenant, which is the caller's. */
export type AdminConnection = Omit<Connection, 'tenantId'>;

export interface AdminConnections {
  connections: AdminConnection[];
  /** The webhook URL to register on the GitHub App: where its signed deliveries are posted. */
  ingress: string;
  /** Whether events are on and the GitHub App's settings resolve, so an install can start. */
  configured: boolean;
}

/**
 * Where to send the admin. `url` installs the app; with "Request user authorization (OAuth)
 * during installation" on, GitHub then returns to the app's Callback URL with a `code` and the
 * installation's id. `authorize` asks the admin to authorize the app alone, for an install made
 * another way; GitHub returns to the Callback URL with a `code`. Both links carry the `state`
 * the bind checks.
 */
export interface ConnectionInstall {
  url: string;
  authorize: string;
}

/**
 * What the app's Callback URL received: the installation's id, the authorization `code` GitHub
 * issued for the admin, and the `state` the link carried. The code proves which installations
 * the admin can access.
 */
export interface ConnectionBindRequest {
  installation: string;
  state: string;
  code: string;
}

export interface ConnectionMarkRequest {
  status: ConnectionStatus;
}

export interface ConnectionRemoved {
  id: string;
  removed: true;
}
