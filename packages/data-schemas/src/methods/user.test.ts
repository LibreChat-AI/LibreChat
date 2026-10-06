import mongoose from 'mongoose';
import type { IUser } from '~/types';
import { createUserMethods } from './user';
import { signPayload } from '~/crypto';

jest.mock('~/crypto', () => ({
  signPayload: jest.fn(),
}));

describe('User Methods', () => {
  const mockSignPayload = signPayload as jest.MockedFunction<typeof signPayload>;
  let userMethods: ReturnType<typeof createUserMethods>;

  beforeEach(() => {
    jest.clearAllMocks();
    userMethods = createUserMethods(mongoose);
  });

  describe('generateToken', () => {
    const mockUser = {
      _id: new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
      username: 'testuser',
      provider: 'local',
      email: 'test@example.com',
      name: 'Test User',
      avatar: '',
      role: 'user',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IUser;

    afterEach(() => {
      delete process.env.JWT_SECRET;
    });

    it('should default to 15 minutes when expiresIn is not provided', async () => {
      process.env.JWT_SECRET = 'test-secret';
      mockSignPayload.mockResolvedValue('mocked-token');

      await userMethods.generateToken(mockUser);

      expect(mockSignPayload).toHaveBeenCalledWith({
        payload: {
          id: mockUser._id,
          username: mockUser.username,
          provider: mockUser.provider,
          email: mockUser.email,
          issuedAtMs: expect.any(Number),
        },
        secret: 'test-secret',
        expirationTime: 900, // 15 minutes in seconds (DEFAULT_SESSION_EXPIRY / 1000)
      });
    });

    it('should default to 15 minutes when expiresIn is undefined', async () => {
      process.env.JWT_SECRET = 'test-secret';
      mockSignPayload.mockResolvedValue('mocked-token');

      await userMethods.generateToken(mockUser, undefined);

      expect(mockSignPayload).toHaveBeenCalledWith({
        payload: {
          id: mockUser._id,
          username: mockUser.username,
          provider: mockUser.provider,
          email: mockUser.email,
          issuedAtMs: expect.any(Number),
        },
        secret: 'test-secret',
        expirationTime: 900, // 15 minutes in seconds (DEFAULT_SESSION_EXPIRY / 1000)
      });
    });

    it('should use custom expiry when expiresIn is provided', async () => {
      process.env.JWT_SECRET = 'test-secret';
      mockSignPayload.mockResolvedValue('mocked-token');

      await userMethods.generateToken(mockUser, 1000 * 60 * 30); // 30 minutes

      expect(mockSignPayload).toHaveBeenCalledWith({
        payload: {
          id: mockUser._id,
          username: mockUser.username,
          provider: mockUser.provider,
          email: mockUser.email,
          issuedAtMs: expect.any(Number),
        },
        secret: 'test-secret',
        expirationTime: 1800, // 30 minutes in seconds
      });
    });

    it('should use 0 when expiresIn is 0', async () => {
      process.env.JWT_SECRET = 'test-secret';
      mockSignPayload.mockResolvedValue('mocked-token');

      // When 0 is passed, it should use 0 (caller's responsibility to pass valid value)
      await userMethods.generateToken(mockUser, 0);

      expect(mockSignPayload).toHaveBeenCalledWith({
        payload: {
          id: mockUser._id,
          username: mockUser.username,
          provider: mockUser.provider,
          email: mockUser.email,
          issuedAtMs: expect.any(Number),
        },
        secret: 'test-secret',
        expirationTime: 0, // 0 seconds
      });
    });

    it('should throw error when no user is provided', async () => {
      process.env.JWT_SECRET = 'test-secret';

      await expect(userMethods.generateToken(null as unknown as IUser)).rejects.toThrow(
        'No user provided',
      );
    });

    it('should return the token from signPayload', async () => {
      process.env.JWT_SECRET = 'test-secret';
      const expectedToken = 'generated-jwt-token';
      mockSignPayload.mockResolvedValue(expectedToken);

      const token = await userMethods.generateToken(mockUser, 1000 * 60 * 60); // 1 hour

      expect(token).toBe(expectedToken);
    });
  });
});
