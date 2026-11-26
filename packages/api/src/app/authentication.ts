import { persistenceConfigSchema } from 'librechat-data-provider';
import type {
  AuthenticationMethods,
  AuthenticationSelection,
  AuthenticationBackend,
  PostgresOptions,
} from '@librechat/data-schemas';

export interface AuthenticationRuntime extends AuthenticationSelection {
  initialize(config: unknown): Promise<void>;
  close(): Promise<void>;
}

/** One authority for authentication state, selected before any request can use captured methods. */
export function createAuthenticationRuntime(
  mongo: AuthenticationMethods,
  env: NodeJS.ProcessEnv,
  createPostgres: (options: PostgresOptions) => AuthenticationBackend,
): AuthenticationRuntime {
  let selected: { kind: 'mongo' | 'postgres'; methods: AuthenticationMethods } | undefined;
  let backend: AuthenticationBackend | undefined;
  let initialization: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  let backendShutdown: Promise<void> | undefined;
  let closed = false;
  const closeBackend = () => (backendShutdown ??= backend?.close() ?? Promise.resolve());
  const authority = () => {
    if (closed || !selected) throw new Error('Authentication persistence is not initialized');
    return selected;
  };
  const methods = () => authority().methods;
  const getMCPAuthorityTokens: AuthenticationMethods['getMCPAuthorityTokens'] = async (input) =>
    methods().getMCPAuthorityTokens(input);
  const reader = { getMCPAuthorityTokens };
  return {
    selectMCPAuthorityTokenReader() {
      return authority().kind === 'mongo' ? null : reader;
    },
    methods: {
      SessionError: mongo.SessionError,
      findMCPTokenUserIds: async (...args) => methods().findMCPTokenUserIds(...args),
      getMCPAuthorityTokens,
      getMCPTokenGenerations: async (...args) => methods().getMCPTokenGenerations(...args),
      findSession: async (...args) => methods().findSession(...args),
      createSession: async (...args) => methods().createSession(...args),
      upsertSession: async (...args) => methods().upsertSession(...args),
      deleteSession: async (...args) => methods().deleteSession(...args),
      deleteAllUserSessions: async (...args) => methods().deleteAllUserSessions(...args),
      generateRefreshToken: async (...args) => methods().generateRefreshToken(...args),
      ensureSessionIndexes: async (...args) => methods().ensureSessionIndexes(...args),
      createPasskey: async (...args) => methods().createPasskey(...args),
      findPasskeysByUser: async (...args) => methods().findPasskeysByUser(...args),
      findPasskeyByCredentialId: async (...args) => methods().findPasskeyByCredentialId(...args),
      countPasskeysByUser: async (...args) => methods().countPasskeysByUser(...args),
      recordPasskeyUse: async (...args) => methods().recordPasskeyUse(...args),
      renamePasskey: async (...args) => methods().renamePasskey(...args),
      deletePasskey: async (...args) => methods().deletePasskey(...args),
      deletePasskeysByUser: async (...args) => methods().deletePasskeysByUser(...args),
      findToken: async (...args) => methods().findToken(...args),
      createToken: async (...args) => methods().createToken(...args),
      replaceTokenIfCurrent: async (...args) => methods().replaceTokenIfCurrent(...args),
      updateToken: async (...args) => methods().updateToken(...args),
      deleteTokens: async (...args) => methods().deleteTokens(...args),
      findTokensOfUser: async (...args) => methods().findTokensOfUser(...args),
      upsertRefreshTokenBridge: async (...args) => methods().upsertRefreshTokenBridge(...args),
      findRefreshTokenBridge: async (...args) => methods().findRefreshTokenBridge(...args),
      deleteRefreshTokenBridges: async (...args) => methods().deleteRefreshTokenBridges(...args),
      acquireOpenIDRefreshFlight: async (...args) => methods().acquireOpenIDRefreshFlight(...args),
      completeOpenIDRefreshFlight: async (...args) =>
        methods().completeOpenIDRefreshFlight(...args),
      renewOpenIDRefreshFlight: async (...args) => methods().renewOpenIDRefreshFlight(...args),
      failOpenIDRefreshFlight: async (...args) => methods().failOpenIDRefreshFlight(...args),
      revokeOpenIDRefreshFlight: async (...args) => methods().revokeOpenIDRefreshFlight(...args),
      claimOpenIDRefreshFlightDelivery: async (...args) =>
        methods().claimOpenIDRefreshFlightDelivery(...args),
      releaseOpenIDRefreshFlightDelivery: async (...args) =>
        methods().releaseOpenIDRefreshFlightDelivery(...args),
      findOpenIDRefreshFlight: async (...args) => methods().findOpenIDRefreshFlight(...args),
    },
    initialize(config) {
      if (closed) return Promise.reject(new Error('Authentication persistence is closed'));
      initialization ??= (async () => {
        const parsed = persistenceConfigSchema.safeParse(config);
        if (!parsed.success) throw new Error('Invalid persistence configuration');
        if (parsed.data.authentication === 'mongo') {
          selected = { kind: 'mongo', methods: mongo };
          return;
        }
        const options = parsed.data.postgres;
        const connectionString = options && env[options.connectionStringEnv];
        if (!options || !connectionString)
          throw new Error('PostgreSQL connection environment variable is missing');
        try {
          backend = createPostgres({ ...options, connectionString });
          await backend.initialize();
          if (closed) throw new Error('Authentication persistence is closed');
          selected = { kind: 'postgres', methods: backend.methods };
        } catch {
          await closeBackend().catch(() => undefined);
          throw new Error('PostgreSQL authentication initialization failed');
        }
      })();
      return initialization;
    },
    close() {
      closed = true;
      shutdown ??= (async () => {
        await initialization?.catch(() => undefined);
        await closeBackend();
      })();
      return shutdown;
    },
  };
}
