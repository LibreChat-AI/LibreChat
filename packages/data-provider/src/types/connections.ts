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
