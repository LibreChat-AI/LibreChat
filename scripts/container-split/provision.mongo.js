/* eslint-disable no-undef */
/**
 * Provision the two MongoDB credentials the auth/API container split requires.
 *
 * Run with mongosh connected to the LibreChat database — the script reads the
 * connected database's name to scope every privilege to it — as a user that can
 * manage roles and users on `admin` (`userAdminAnyDatabase`, or `root`):
 *
 *   mongosh "$MONGO_ADMIN_URI" \
 *     --eval 'var AUTH_PASSWORD = "..."; var API_PASSWORD = "..."' \
 *     --file scripts/container-split/provision.mongo.js
 *
 * Dry run — prints the grant it would provision and writes nothing. Passwords
 * are not required in this mode:
 *
 *   mongosh "$MONGO_ADMIN_URI" --eval 'var DRY_RUN = true' \
 *     --file scripts/container-split/provision.mongo.js
 *
 * Role and user names can be overridden the same way, with
 * `AUTH_ROLE_NAME`, `AUTH_USER_NAME`, `API_ROLE_NAME`, and `API_USER_NAME`.
 *
 * The per-container environment values, the `librechat.yaml` rules, and the
 * manual ban copy that accompany these grants are in
 * `scripts/container-split/env-matrix.md`.
 *
 * Where the roles and users live
 * -------------------------------
 * Both roles and both users are created on the `admin` database, while every
 * privilege inside them stays scoped to the LibreChat database and to named
 * collections within it. Those are two independent things: the authentication
 * database is where a credential is defined, and the privilege resource is what
 * it reaches. Putting the definitions on `admin` keeps all database credentials
 * in one place for rotation and audit, and leaves room for a role that needs a
 * resource outside the LibreChat database — which a role defined on a
 * non-admin database cannot express at all.
 *
 * The consequence for the containers is that each connection string carries
 * `authSource=admin`, not `authSource=<the LibreChat database>`. A credential
 * provisioned by an earlier version of this script was defined on the LibreChat
 * database instead; re-running here does not move it, so drop the old user from
 * that database once the containers authenticate against `admin`.
 *
 * What this provisions
 * --------------------
 * Two credentials, one per container, matching the design's collection
 * ownership matrix:
 *
 *   - The auth surface (container 1) — the internet-facing container serving
 *     login, registration, 2FA, password reset, email verification, the admin
 *     login and OAuth paths, `/api/config`, `/api/banner`, and the SPA. Its
 *     grant reaches exactly twelve collections: read-write on `users`,
 *     `sessions`, `authtokens`, `balances`, `bans`, `groups`,
 *     `refreshtokenbridges`, and `openidrefreshflights`; read-only on `roles`,
 *     `configs`, `systemgrants`, and `banners`. Read-write here includes
 *     `createIndex`, because the auth surface's own request paths build
 *     indexes on collections it writes — see `WRITE_ACTIONS` below. The action
 *     vocabulary used throughout is the portable intersection across MongoDB
 *     and Amazon DocumentDB 5.0, verified against a real cluster. Nothing
 *     else — no database-wide privilege, no pattern-based privilege, and no
 *     inherited role that could widen it.
 *
 *   - The API container (container 2) — reachable only through the auth gate,
 *     and holding read-write access to every collection in the database.
 *
 * The grant is the enforcement boundary, not the route table. Both containers
 * run the same image and mount every route, so the auth surface's collection
 * reach cannot be derived from what it serves; it is exactly what this script
 * provisions. A route the auth surface mounts but whose collection this grant
 * omits fails at the database layer, which is the intended outcome.
 *
 * Recompute this grant when routing changes
 * -----------------------------------------
 * The auth surface's privilege set is derived from the collections that the
 * paths *routed to it* need. Whenever a path moves between the two routed path
 * sets — added to the load balancer's auth-surface allowlist, or removed from
 * it and sent to the gate instead — the auth surface's grant must be
 * RECOMPUTED from the moved path's collection needs, not merely re-asserted by
 * re-running this script unchanged.
 *
 * Re-running it unchanged re-asserts the twelve collections below and proves
 * nothing about the moved path. A newly routed path that reads, say, `files`
 * or `tokens` will fail at the database layer, and on the group-sync and
 * capability-check paths that failure is caught and logged rather than
 * surfaced, so it degrades quietly instead of loudly. Work out what the moved
 * path touches, edit the two collection lists below, and provision again
 * before the changed routing takes effect.
 *
 * Idempotent. An existing role is updated with the full recomputed privilege
 * and inherited-role set rather than added to, and an existing user's role
 * array is replaced rather than appended to, so a previously broader grant is
 * narrowed by re-running rather than left in place.
 */

/**
 * The connected database is the one every privilege is scoped to. The roles and
 * users themselves are created on `admin`, so the two names are kept separate
 * throughout: `dbName` appears only inside privilege resources, `ADMIN_DB` only
 * in role and user management.
 */
const dbName = db.getName();
const ADMIN_DB = 'admin';
const adminDb = db.getSiblingDB(ADMIN_DB);

/**
 * Read-write for the auth surface. Every one of these is forced by a path
 * routed to it: all passport strategies, registration, 2FA and `jwtStrategy`
 * role backfill (`users`); session create/find/delete (`sessions`); password
 * reset, email verification, and invite consumption (`authtokens`); the
 * `createUser` start-balance upsert and `setBalanceConfig` on login
 * (`balances`); the `checkBan` cache and ban violation log (`bans`); and the
 * OAuth callback's Entra group membership sync, which adds and removes members
 * and creates group documents (`groups`).
 *
 * `groups` needs write only where Entra group sync is enabled —
 * `USE_ENTRA_ID_FOR_PEOPLE_SEARCH` and `OPENID_REUSE_TOKENS` both on an
 * `openid` provider. Deployments without it can move `groups` to the read-only
 * list below, where the admin login paths' capability checks still work.
 *
 * `refreshtokenbridges` and `openidrefreshflights` are read-write, not
 * read-only. Both are written *primarily* by the auth surface's own refresh
 * and logout paths (`/api/auth/refresh` and `/api/auth/logout`) — the
 * `RefreshTokenBridge` rotation bridge and the `OpenIDRefreshFlight`
 * cross-worker inline-refresh coordination — so the auth surface must be able
 * to write both. The API container also writes both on its OBO inline-refresh
 * path when a tool call's access token has expired, but that shared write does
 * not make them the API container's alone: the auth surface is the primary
 * writer, which is why both belong in this read-write list rather than the
 * read-only one below.
 */
const AUTH_READ_WRITE = [
  'users',
  'sessions',
  'authtokens',
  'balances',
  'bans',
  'groups',
  'refreshtokenbridges',
  'openidrefreshflights',
];

/**
 * Read-only for the auth surface: `findRolesByNames` for OIDC role sync
 * (`roles`), `getAppConfig` tenant and role overrides (`configs`), the
 * `requireAdminAccess` capability lookup (`systemgrants`), and the login page
 * (`banners`). Writes to these belong to the API container's bootstrap and
 * admin paths, so a write attempted here is refused and the documents are left
 * unchanged.
 */
const AUTH_READ_ONLY = ['roles', 'configs', 'systemgrants', 'banners'];

/**
 * Collection-scoped read actions. Nothing here applies at database scope.
 *
 * The set is `find` alone because that is the portable intersection across
 * MongoDB and Amazon DocumentDB 5.0: DocumentDB's `createRole` does not accept
 * `planCacheRead`, and `listIndexes`, `collStats`, and `changeStream` are not
 * used by any path routed to the auth surface — change streams are
 * additionally unavailable on DocumentDB elastic clusters.
 *
 * A narrower read set fails closed at the database layer rather than
 * degrading, which is the intended behavior of this grant: a path that needs
 * more than `find` on one of these collections is refused outright instead of
 * quietly returning less.
 */
const READ_ACTIONS = ['find'];

/**
 * `createIndex` is granted on every read-write collection, not on the subset
 * known to need it today.
 *
 * `MONGO_AUTO_INDEX=false` suppresses Mongoose's automatic build at model
 * registration. It does not suppress an explicit `Model.createIndexes()`, and
 * several method layers in `@librechat/data-schemas` issue exactly that,
 * memoized per process, before their first write:
 *
 *   - `sessions` — `createSession` and `upsertSession`, so every login
 *   - `refreshtokenbridges` — `storeRefreshTokenBridge`, on `/api/auth/refresh`
 *   - `openidrefreshflights` — `acquireOpenIDRefreshFlight` on the refresh path
 *     and `revokeOpenIDRefreshFlight` on `/api/auth/logout`
 *
 * All three sit on paths routed to the auth surface, so it is the container
 * that indexes those collections. That is deliberate: indexing before the
 * first write is what keeps these collections out of the first-boot ordering
 * window that `authtokens` has, where documents can land before the TTL index
 * exists. Requirement 8.34 states it as the intended arrangement.
 *
 * Three details make a narrower grant fail rather than degrade. Authorization
 * is checked before the server decides a build is a no-op, so an
 * already-indexed collection is refused identically. The memo is per process,
 * so every worker issues the build on its first write, not once per
 * deployment. And `createIndexesWithRetry` treats an authorization error as
 * non-retryable, so it throws on the first attempt out of a live auth path.
 *
 * Granting the action across all eight keeps the grant correct when another
 * method layer adopts the same pattern, which is a change no one would think
 * to re-provision for. The alternative fails closed on login or refresh, in
 * production, with nothing in the diff pointing here. The action's reach is
 * narrow by comparison: it builds indexes on eight collections this credential
 * can already write, it cannot drop an index (`dropIndex` is not granted), and
 * the indexes built are the ones the shared schema declares.
 *
 * As a side effect this also covers the first write to a collection that does
 * not exist yet, since `createIndex` on a missing collection creates it.
 */
const WRITE_ACTIONS = ['insert', 'update', 'remove', 'createIndex'];

const privilegeFor = function (collection, actions) {
  return {
    resource: { db: dbName, collection: collection },
    actions: actions,
  };
};

/**
 * `createCollection` is not granted anywhere in this role. The grant verified
 * against a real Amazon DocumentDB 5.0 cluster omits it, and nothing needs it:
 * `createIndex` already creates a missing collection, so `authtokens` and
 * `bans` still materialize on first use, and the auth surface runs
 * `MONGO_AUTO_CREATE=false` per `scripts/container-split/env-matrix.md`, so no
 * code path on that container issues an explicit `createCollection`.
 *
 * Re-adding it would break provisioning on DocumentDB, whose `createRole` does
 * not accept the action. It is not a fix for a first-write failure.
 */
const readWritePrivilege = function (collection) {
  return privilegeFor(collection, READ_ACTIONS.concat(WRITE_ACTIONS));
};

const readOnlyPrivilege = function (collection) {
  return privilegeFor(collection, READ_ACTIONS);
};

const authPrivileges = AUTH_READ_WRITE.map(readWritePrivilege).concat(
  AUTH_READ_ONLY.map(readOnlyPrivilege),
);

/**
 * Guards on the computed privilege set, checked before anything is written.
 *
 * The empty collection name is what makes a privilege database-wide in
 * MongoDB, so an empty `collection` on any resource here would silently reach
 * every collection in the database and defeat the whole point of the grant.
 * A collection listed in both modes would do the same, since privileges union
 * rather than override.
 *
 * Connecting to `admin` and running this is the third way to get a wrong
 * grant, and the most plausible one now that the roles and users are created
 * there: `dbName` would resolve to `admin`, and the privileges would name
 * collections on the credential database rather than on LibreChat's.
 */
const assertGrantIsScoped = function (privileges) {
  if (dbName === ADMIN_DB) {
    throw new Error(
      'Refusing to provision: connect to the LibreChat database, not ' +
        ADMIN_DB +
        '. Privileges are scoped to the connected database; the roles and users are ' +
        'created on ' +
        ADMIN_DB +
        ' regardless of where this runs from.',
    );
  }

  const unscoped = privileges.filter(function (privilege) {
    return !privilege.resource.collection || privilege.resource.db !== dbName;
  });
  if (unscoped.length !== 0) {
    throw new Error(
      'Refusing to provision: ' +
        unscoped.length +
        ' privilege(s) are not scoped to a named collection on ' +
        dbName,
    );
  }

  const overlap = AUTH_READ_WRITE.filter(function (collection) {
    return AUTH_READ_ONLY.indexOf(collection) !== -1;
  });
  if (overlap.length !== 0) {
    throw new Error(
      'Refusing to provision: ' + overlap.join(', ') + ' listed as both read-write and read-only',
    );
  }

  if (privileges.length !== AUTH_READ_WRITE.length + AUTH_READ_ONLY.length) {
    throw new Error('Refusing to provision: privilege count does not match the collection lists');
  }

  /**
   * `createIndex` is granted broadly across the read-write list, so the guard
   * that keeps it from reaching the read-only list has to be explicit: a
   * collection moved from one list to the other must lose every mutating
   * action, and `createIndex` is the one most easily left behind.
   */
  const mutating = WRITE_ACTIONS;
  const writableReadOnly = privileges.filter(function (privilege) {
    if (AUTH_READ_ONLY.indexOf(privilege.resource.collection) === -1) {
      return false;
    }
    return privilege.actions.some(function (action) {
      return mutating.indexOf(action) !== -1;
    });
  });
  if (writableReadOnly.length !== 0) {
    throw new Error(
      'Refusing to provision: ' +
        writableReadOnly
          .map(function (privilege) {
            return privilege.resource.collection;
          })
          .join(', ') +
        ' is read-only but carries a mutating action',
    );
  }
};

const authRoleName =
  typeof AUTH_ROLE_NAME !== 'undefined' ? AUTH_ROLE_NAME : 'librechatAuthSurface';
const authUserName =
  typeof AUTH_USER_NAME !== 'undefined' ? AUTH_USER_NAME : 'librechat_auth_surface';
const apiRoleName = typeof API_ROLE_NAME !== 'undefined' ? API_ROLE_NAME : 'librechatApiContainer';
const apiUserName =
  typeof API_USER_NAME !== 'undefined' ? API_USER_NAME : 'librechat_api_container';
const authPassword = typeof AUTH_PASSWORD !== 'undefined' ? AUTH_PASSWORD : null;
const apiPassword = typeof API_PASSWORD !== 'undefined' ? API_PASSWORD : null;

const dryRun = typeof DRY_RUN !== 'undefined' && DRY_RUN === true;

print('');
print('LibreChat container grant provisioning');
print('  privileges scoped to: ' + dbName);
print('  roles and users on:   ' + ADMIN_DB + ' (each container uses authSource=' + ADMIN_DB + ')');
print('  mode:                 ' + (dryRun ? 'DRY RUN (no writes)' : 'apply'));
print('');

assertGrantIsScoped(authPrivileges);

print('Auth surface (container 1) — role ' + authRoleName + ', user ' + authUserName);
print('  read-write: ' + AUTH_READ_WRITE.join(', '));
print('  read-only:  ' + AUTH_READ_ONLY.join(', '));
print('  reaches nothing else: no database-wide or pattern-based privilege, no inherited role');
print('  index creation permitted on every read-write collection above, and on no other');
print('');
print('API container (container 2) — role ' + apiRoleName + ', user ' + apiUserName);
print('  read-write: every collection on ' + dbName + ' (inherits built-in readWrite)');
print('');

if (dryRun) {
  print('Computed auth surface privileges:');
  authPrivileges.forEach(function (privilege) {
    print('  ' + privilege.resource.collection + ': ' + privilege.actions.join(', '));
  });
  print('');
  print('Dry run complete. No roles or users were created or modified.');
} else {
  if (!authPassword || !apiPassword) {
    throw new Error(
      'AUTH_PASSWORD and API_PASSWORD are both required. Pass them with ' +
        '--eval \'var AUTH_PASSWORD = "..."; var API_PASSWORD = "..."\', or use DRY_RUN.',
    );
  }
  if (authPassword === apiPassword) {
    throw new Error(
      'Refusing to provision: the two containers must not share a password, since each ' +
        'credential is meant to be used by exactly one container',
    );
  }

  /**
   * Created on `admin`, with privileges that name the LibreChat database.
   *
   * `updateRole` replaces the fields it is given rather than merging them, so
   * passing both `privileges` and `roles` recomputes the grant from the lists
   * above and drops anything a previous run left behind.
   */
  const applyRole = function (name, privileges, inherited) {
    const definition = { privileges: privileges, roles: inherited };
    if (adminDb.getRole(name) !== null) {
      adminDb.updateRole(name, definition);
      print('  role ' + ADMIN_DB + '.' + name + ': recomputed');
      return;
    }
    adminDb.createRole({
      role: name,
      privileges: privileges,
      roles: inherited,
    });
    print('  role ' + ADMIN_DB + '.' + name + ': created');
  };

  /**
   * Created on `admin`, which is therefore each container's `authSource`. The
   * role reference names `admin` too, since that is where `applyRole` defined
   * it — a `db` of the LibreChat database here would not resolve.
   *
   * `updateUser` replaces the role array, narrowing a previously broader user.
   */
  const applyUser = function (name, password, roleName) {
    const grant = [{ role: roleName, db: ADMIN_DB }];
    if (adminDb.getUser(name) !== null) {
      adminDb.updateUser(name, { pwd: password, roles: grant });
      print('  user ' + ADMIN_DB + '.' + name + ': password and roles replaced');
      return;
    }
    adminDb.createUser({ user: name, pwd: password, roles: grant });
    print('  user ' + ADMIN_DB + '.' + name + ': created');
  };

  print('Provisioning...');
  applyRole(authRoleName, authPrivileges, []);
  applyRole(apiRoleName, [], [{ role: 'readWrite', db: dbName }]);
  applyUser(authUserName, authPassword, authRoleName);
  applyUser(apiUserName, apiPassword, apiRoleName);

  print('');
  print('Done.');
  print('');
  print('Give each container its own credential, and only its own.');
  print('Both users live on ' + ADMIN_DB + ', so both connection strings authenticate there');
  print('while addressing ' + dbName + ' as the default database:');
  print(
    '  container 1: mongodb://' +
      authUserName +
      ':<pw>@<host>/' +
      dbName +
      '?authSource=' +
      ADMIN_DB,
  );
  print(
    '  container 2: mongodb://' +
      apiUserName +
      ':<pw>@<host>/' +
      dbName +
      '?authSource=' +
      ADMIN_DB,
  );
  print('');
  print('Verify with, from any connected database:');
  print(
    "  db.getSiblingDB('" +
      ADMIN_DB +
      "').getRole('" +
      authRoleName +
      "', { showPrivileges: true })",
  );
  print("  db.getSiblingDB('" + ADMIN_DB + "').getUser('" + authUserName + "')");
  print('');
  print('Then boot each container against its own credential and confirm zero authorization');
  print('errors across its startup logs before any request-level verification.');
}

print('');
