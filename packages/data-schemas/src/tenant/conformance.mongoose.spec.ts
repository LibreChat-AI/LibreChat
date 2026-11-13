import { MongoMemoryServer } from 'mongodb-memory-server';
import { describeTenantIsolationConformance } from './conformance';
import { createMongooseTenantHarness } from './harness';

/**
 * The Mongoose binding's answer to the portable contract. A PostgreSQL engine
 * satisfies the same suite by supplying its own harness — that is what makes
 * the seam real rather than hypothetical.
 */

let server: MongoMemoryServer;

describeTenantIsolationConformance(
  createMongooseTenantHarness({
    name: 'mongoose',
    async connect() {
      server = await MongoMemoryServer.create();
      return server.getUri();
    },
    async release() {
      await server.stop();
    },
  }),
);
