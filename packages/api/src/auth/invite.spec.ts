import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import { createInvite, getInvite } from './invite';

let mongoServer: MongoMemoryServer;
let deps: Parameters<typeof getInvite>[2];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);

  const { createToken, findToken } = createMethods(mongoose);
  deps = { createToken, findToken } as Parameters<typeof getInvite>[2];
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Token.deleteMany({});
});

describe('getInvite', () => {
  it('returns the invite for the address it was issued to', async () => {
    const token = (await createInvite('pedro@example.com', deps)) as string;

    await expect(getInvite(token, 'pedro@example.com', deps)).resolves.toMatchObject({
      email: 'pedro@example.com',
    });
  });

  it('refuses an address the invite was not issued to', async () => {
    const token = (await createInvite('pedro@example.com', deps)) as string;

    await expect(getInvite(token, 'someone.else@example.com', deps)).resolves.toMatchObject({
      error: true,
    });
  });

  it('refuses a lookup carrying no address at all', async () => {
    const token = (await createInvite('pedro@example.com', deps)) as string;

    await expect(getInvite(token, undefined as unknown as string, deps)).resolves.toMatchObject({
      error: true,
    });
  });
});
