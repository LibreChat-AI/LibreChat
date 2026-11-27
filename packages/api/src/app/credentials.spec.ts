import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Collection } from 'mongodb';
import type { CredentialFingerprintRecord, CredentialName } from '~/credentials';
import {
  credentialMetadataCollection,
  credentialMetadataId,
  credentialNames,
  getCredentialFingerprints,
} from '~/credentials';
import { checkCredentialDatabase } from './checks';

const configuredCredentials: Record<CredentialName, string> = {
  CREDS_KEY: 'a'.repeat(64),
  CREDS_IV: 'b'.repeat(32),
  JWT_SECRET: 'c'.repeat(64),
  JWT_REFRESH_SECRET: 'd'.repeat(64),
};

interface CredentialMetadataDocument {
  _id: string;
  fingerprints: CredentialFingerprintRecord;
  createdAt: Date;
}

function getCredentialMetadataCollection(): Collection<CredentialMetadataDocument> {
  return mongoose.connection.db!.collection<CredentialMetadataDocument>(
    credentialMetadataCollection,
  );
}

describe('checkCredentialDatabase', () => {
  const originalEnv = process.env;
  let mongoServer: MongoMemoryServer | undefined;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    mongoose.model('User', new mongoose.Schema({}, { collection: 'users', strict: false }));
    await mongoose.connect(mongoServer.getUri());
  });

  beforeEach(async () => {
    process.env = { ...originalEnv, ...configuredCredentials };
    await Promise.all([
      mongoose.models.User.deleteMany({}),
      getCredentialMetadataCollection().deleteMany({ _id: credentialMetadataId }),
    ]);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  it('records fingerprints for a new database', async () => {
    jest.spyOn(logger, 'info').mockImplementation();
    await checkCredentialDatabase();

    const metadata = await getCredentialMetadataCollection().findOne({
      _id: credentialMetadataId,
    });
    expect(metadata?.fingerprints).toEqual(getCredentialFingerprints());
  });

  it('does not establish a marker for a database that already has users', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation();
    await mongoose.models.User.collection.insertOne({ email: 'existing@example.com' });

    await checkCredentialDatabase();

    const metadata = await getCredentialMetadataCollection().findOne({
      _id: credentialMetadataId,
    });
    expect(metadata).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Existing database has no credential fingerprint record'),
    );
  });

  it('warns without overwriting a mismatched marker', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation();
    const originalFingerprints = getCredentialFingerprints();
    await getCredentialMetadataCollection().insertOne({
      _id: credentialMetadataId,
      fingerprints: originalFingerprints,
      createdAt: new Date(),
    });
    process.env.JWT_SECRET = 'e'.repeat(64);

    await checkCredentialDatabase();

    const metadata = await getCredentialMetadataCollection().findOne({
      _id: credentialMetadataId,
    });
    expect(metadata?.fingerprints).toEqual(originalFingerprints);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('JWT_SECRET'));
  });

  it('accepts a marker that matches all active credentials', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation();
    await getCredentialMetadataCollection().insertOne({
      _id: credentialMetadataId,
      fingerprints: getCredentialFingerprints(),
      createdAt: new Date(),
    });

    await checkCredentialDatabase();

    expect(warn).not.toHaveBeenCalled();
    expect(credentialNames).toHaveLength(4);
  });
});
