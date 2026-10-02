import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { LegacyVerificationDeps, UserDocumentId } from './verification';
import { grandfatherLegacyEmailVerification, verificationEnabledTimestamp } from './verification';

/** Either side of the cutoff, expressed the way Mongo hands the field back. */
const BEFORE_CUTOFF = new Date((verificationEnabledTimestamp - 86_400) * 1000);
const AFTER_CUTOFF = new Date((verificationEnabledTimestamp + 86_400) * 1000);
const EMAIL_KEYS = ['EMAIL_SERVICE', 'EMAIL_HOST', 'EMAIL_FROM', 'MAILGUN_API_KEY'] as const;

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let deps: LegacyVerificationDeps & { updateUser: jest.Mock };
let savedEnv: Partial<Record<(typeof EMAIL_KEYS)[number], string>>;

async function createUser(createdAt: Date, emailVerified = false): Promise<IUser> {
  const doc = await mongoose.models.User.create({
    email: `user-${new mongoose.Types.ObjectId().toString()}@example.com`,
    provider: 'local',
    emailVerified,
  });
  await mongoose.models.User.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
  return (await methods.getUserById(doc._id.toString())) as IUser;
}

async function storedVerification(user: IUser): Promise<boolean | undefined> {
  return (await methods.getUserById(user._id.toString()))?.emailVerified;
}

function configureEmail(enabled: boolean): void {
  if (enabled) {
    process.env.EMAIL_SERVICE = 'smtp';
    process.env.EMAIL_FROM = 'noreply@example.com';
  }
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  savedEnv = Object.fromEntries(EMAIL_KEYS.map((key) => [key, process.env[key]]));
  for (const key of EMAIL_KEYS) {
    delete process.env[key];
  }
  deps = {
    updateUser: jest.fn((userId: UserDocumentId, update: { emailVerified: boolean }) =>
      methods.updateUser(userId.toString(), update),
    ),
  };
  await mongoose.models.User.deleteMany({});
});

afterEach(() => {
  for (const key of EMAIL_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe('grandfatherLegacyEmailVerification', () => {
  it('verifies a pre-cutoff account when no email is configured', async () => {
    const user = await createUser(BEFORE_CUTOFF);

    await expect(grandfatherLegacyEmailVerification(deps, user)).resolves.toBe(true);
    expect(deps.updateUser).toHaveBeenCalledWith(user._id, { emailVerified: true });
    expect(user.emailVerified).toBe(true);
    expect(await storedVerification(user)).toBe(true);
  });

  it('leaves a post-cutoff account unverified', async () => {
    const user = await createUser(AFTER_CUTOFF);

    await expect(grandfatherLegacyEmailVerification(deps, user)).resolves.toBe(false);
    expect(deps.updateUser).not.toHaveBeenCalled();
    expect(user.emailVerified).toBe(false);
  });

  it('leaves a pre-cutoff account alone when email is configured', async () => {
    configureEmail(true);
    const user = await createUser(BEFORE_CUTOFF);

    await expect(grandfatherLegacyEmailVerification(deps, user)).resolves.toBe(false);
    expect(deps.updateUser).not.toHaveBeenCalled();
    expect(await storedVerification(user)).toBe(false);
  });

  it('short-circuits an already verified account without writing', async () => {
    const user = await createUser(BEFORE_CUTOFF, true);

    await expect(grandfatherLegacyEmailVerification(deps, user)).resolves.toBe(true);
    expect(deps.updateUser).not.toHaveBeenCalled();
  });

  it('does not verify when createdAt is unreadable', async () => {
    const user = {
      _id: new mongoose.Types.ObjectId(),
      emailVerified: false,
      createdAt: 'not-a-date',
    };

    await expect(grandfatherLegacyEmailVerification(deps, user)).resolves.toBe(false);
    expect(deps.updateUser).not.toHaveBeenCalled();
  });

  it('refuses a missing user', async () => {
    await expect(grandfatherLegacyEmailVerification(deps, null)).resolves.toBe(false);
  });

  it('falls back to id when the document has no _id', async () => {
    const stored = await createUser(BEFORE_CUTOFF);
    const user = { id: stored._id.toString(), emailVerified: false, createdAt: BEFORE_CUTOFF };

    await expect(grandfatherLegacyEmailVerification(deps, user)).resolves.toBe(true);
    expect(deps.updateUser).toHaveBeenCalledWith(user.id, { emailVerified: true });
    expect(await storedVerification(stored)).toBe(true);
  });
});
