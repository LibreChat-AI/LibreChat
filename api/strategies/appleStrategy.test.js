const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { Strategy: AppleStrategy } = require('passport-apple');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createSocialUser, handleExistingUser } = require('./process');
const socialLogin = require('./socialLogin');
const { findUser } = require('~/models');
const { User } = require('~/db/models');

jest.mock('jsonwebtoken');
jest.mock('@librechat/data-schemas', () => {
  const actualModule = jest.requireActual('@librechat/data-schemas');
  return {
    ...actualModule,
    logger: {
      error: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
  };
});
jest.mock('./process', () => ({
  createSocialUser: jest.fn(),
  handleExistingUser: jest.fn(),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: jest.fn(),
}));
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  updateUser: jest.fn(),
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({
    fileStrategy: 'local',
    balance: { enabled: false },
  }),
}));

describe('Apple Login Strategy', () => {
  let mongoServer;
  let appleStrategyInstance;
  const OLD_ENV = process.env;
  let getProfileDetails;

  // Start and stop in-memory MongoDB
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
    process.env = OLD_ENV;
  });

  beforeEach(async () => {
    // Reset environment variables
    process.env = { ...OLD_ENV };
    process.env.APPLE_CLIENT_ID = 'fake_client_id';
    process.env.APPLE_TEAM_ID = 'fake_team_id';
    process.env.APPLE_CALLBACK_URL = '/auth/apple/callback';
    process.env.DOMAIN_SERVER = 'https://example.com';
    process.env.APPLE_KEY_ID = 'fake_key_id';
    process.env.APPLE_PRIVATE_KEY_PATH = '/path/to/fake/private/key';
    process.env.ALLOW_SOCIAL_REGISTRATION = 'true';

    // Clear mocks and database
    jest.clearAllMocks();
    await User.deleteMany({});

    // Define getProfileDetails within the test scope
    getProfileDetails = ({ idToken, profile }) => {
      if (!idToken) {
        logger.error('idToken is missing');
        throw new Error('idToken is missing');
      }

      const decoded = jwt.decode(idToken);
      if (!decoded) {
        logger.error('Failed to decode idToken');
        throw new Error('idToken is invalid');
      }

      console.log('Decoded token:', decoded);

      logger.debug(`Decoded Apple JWT: ${JSON.stringify(decoded, null, 2)}`);

      return {
        email: decoded.email,
        id: decoded.sub,
        avatarUrl: null, // Apple does not provide an avatar URL
        username: decoded.email ? decoded.email.split('@')[0].toLowerCase() : `user_${decoded.sub}`,
        name: decoded.name
          ? `${decoded.name.firstName} ${decoded.name.lastName}`
          : profile.displayName || null,
        emailVerified: true, // Apple verifies the email
      };
    };

    // Mock isEnabled based on environment variable
    isEnabled.mockImplementation((flag) => {
      if (flag === 'true') {
        return true;
      }
      if (flag === 'false') {
        return false;
      }
      return false;
    });

    // Initialize the strategy with the mocked getProfileDetails
    const appleLogin = socialLogin('apple', getProfileDetails);
    appleStrategyInstance = new AppleStrategy(
      {
        clientID: process.env.APPLE_CLIENT_ID,
        teamID: process.env.APPLE_TEAM_ID,
        callbackURL: `${process.env.DOMAIN_SERVER}${process.env.APPLE_CALLBACK_URL}`,
        keyID: process.env.APPLE_KEY_ID,
        privateKeyLocation: process.env.APPLE_PRIVATE_KEY_PATH,
        passReqToCallback: false,
      },
      appleLogin,
    );
  });

  const mockProfile = {
    displayName: 'John Doe',
  };

  describe('getProfileDetails', () => {
    it('should throw an error if idToken is missing', () => {
      expect(() => {
        getProfileDetails({ idToken: null, profile: mockProfile });
      }).toThrow('idToken is missing');
      expect(logger.error).toHaveBeenCalledWith('idToken is missing');
    });

    it('should throw an error if idToken cannot be decoded', () => {
      jwt.decode.mockReturnValue(null);
      expect(() => {
        getProfileDetails({ idToken: 'invalid_id_token', profile: mockProfile });
      }).toThrow('idToken is invalid');
      expect(logger.error).toHaveBeenCalledWith('Failed to decode idToken');
    });

    it('should extract user details correctly from idToken', () => {
      const fakeDecodedToken = {
        email: 'john.doe@example.com',
        sub: 'apple-sub-1234',
        name: {
          firstName: 'John',
          lastName: 'Doe',
        },
      };

      jwt.decode.mockReturnValue(fakeDecodedToken);

      const profileDetails = getProfileDetails({
        idToken: 'fake_id_token',
        profile: mockProfile,
      });

      expect(jwt.decode).toHaveBeenCalledWith('fake_id_token');
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Decoded Apple JWT'));
      expect(profileDetails).toEqual({
        email: 'john.doe@example.com',
        id: 'apple-sub-1234',
        avatarUrl: null,
        username: 'john.doe',
        name: 'John Doe',
        emailVerified: true,
      });
    });

    it('should handle missing email and use sub for username', () => {
      const fakeDecodedToken = {
        sub: 'apple-sub-5678',
      };

      jwt.decode.mockReturnValue(fakeDecodedToken);

      const profileDetails = getProfileDetails({
        idToken: 'fake_id_token',
        profile: mockProfile,
      });

      expect(profileDetails).toEqual({
        email: undefined,
        id: 'apple-sub-5678',
        avatarUrl: null,
        username: 'user_apple-sub-5678',
        name: 'John Doe',
        emailVerified: true,
      });
    });
  });

  describe('Strategy verify callback', () => {
    const tokenset = {
      id_token: 'fake_id_token',
    };

    const decodedToken = {
      email: 'jane.doe@example.com',
      sub: 'apple-sub-9012',
      name: {
        firstName: 'Jane',
        lastName: 'Doe',
      },
    };

    const fakeAccessToken = 'fake_access_token';
    const fakeRefreshToken = 'fake_refresh_token';

    beforeEach(() => {
      jwt.decode.mockReturnValue(decodedToken);
      findUser.mockResolvedValue(null);
    });

    it('should create a new user if one does not exist and registration is allowed', async () => {
      // Mock findUser to return null (user does not exist)
      findUser.mockResolvedValue(null);

      // Mock createSocialUser to create a user
      createSocialUser.mockImplementation(async (userData) => {
        const user = new User(userData);
        await user.save();
        return user;
      });

      const mockVerifyCallback = jest.fn();

      // Invoke the verify callback with correct arguments
      await new Promise((resolve) => {
        appleStrategyInstance._verify(
          fakeAccessToken,
          fakeRefreshToken,
          tokenset.id_token,
          mockProfile,
          (err, user) => {
            mockVerifyCallback(err, user);
            resolve();
          },
        );
      });

      expect(mockVerifyCallback).toHaveBeenCalledWith(null, expect.any(User));
      const user = mockVerifyCallback.mock.calls[0][1];
      expect(user.email).toBe('jane.doe@example.com');
      expect(user.username).toBe('jane.doe');
      expect(user.name).toBe('Jane Doe');
      expect(user.provider).toBe('apple');
    });

    it('should handle existing user and update avatarUrl', async () => {
      // Create an existing user without saving to database
      const existingUser = new User({
        email: 'jane.doe@example.com',
        username: 'jane.doe',
        name: 'Jane Doe',
        provider: 'apple',
        providerId: 'apple-sub-9012',
        avatarUrl: 'old_avatar.png',
      });

      // Mock findUser to return the existing user
      findUser.mockResolvedValue(existingUser);

      // Mock handleExistingUser to update avatarUrl without saving to database
      handleExistingUser.mockImplementation(async (user, avatarUrl) => {
        user.avatarUrl = avatarUrl;
        // Don't call save() to avoid database operations
        return user;
      });

      const mockVerifyCallback = jest.fn();

      // Invoke the verify callback with correct arguments
      await new Promise((resolve) => {
        appleStrategyInstance._verify(
          fakeAccessToken,
          fakeRefreshToken,
          tokenset.id_token,
          mockProfile,
          (err, user) => {
            mockVerifyCallback(err, user);
            resolve();
          },
        );
      });

      expect(mockVerifyCallback).toHaveBeenCalledWith(null, existingUser);
      expect(existingUser.avatarUrl).toBeNull(); // As per getProfileDetails
      expect(handleExistingUser).toHaveBeenCalledWith(
        existingUser,
        null,
        expect.objectContaining({
          fileStrategy: 'local',
          balance: { enabled: false },
        }),
        'jane.doe@example.com',
      );
    });

    it('should handle missing idToken gracefully', async () => {
      const mockVerifyCallback = jest.fn();

      // Invoke the verify callback with missing id_token
      await new Promise((resolve) => {
        appleStrategyInstance._verify(
          fakeAccessToken,
          fakeRefreshToken,
          null, // idToken is missing
          mockProfile,
          (err, user) => {
            mockVerifyCallback(err, user);
            resolve();
          },
        );
      });

      expect(mockVerifyCallback).toHaveBeenCalledWith(expect.any(Error), undefined);
      expect(mockVerifyCallback.mock.calls[0][0].message).toBe('idToken is missing');
      // Ensure createSocialUser and handleExistingUser were not called
      expect(createSocialUser).not.toHaveBeenCalled();
      expect(handleExistingUser).not.toHaveBeenCalled();
    });

    it('should handle decoding errors gracefully', async () => {
      // Simulate decoding failure by returning null
      jwt.decode.mockReturnValue(null);

      const mockVerifyCallback = jest.fn();

      // Invoke the verify callback with correct arguments
      await new Promise((resolve) => {
        appleStrategyInstance._verify(
          fakeAccessToken,
          fakeRefreshToken,
          tokenset.id_token,
          mockProfile,
          (err, user) => {
            mockVerifyCallback(err, user);
            resolve();
          },
        );
      });

      expect(mockVerifyCallback).toHaveBeenCalledWith(expect.any(Error), undefined);
      expect(mockVerifyCallback.mock.calls[0][0].message).toBe('idToken is invalid');
      // Ensure createSocialUser and handleExistingUser were not called
      expect(createSocialUser).not.toHaveBeenCalled();
      expect(handleExistingUser).not.toHaveBeenCalled();
      // Ensure logger.error was called
      expect(logger.error).toHaveBeenCalledWith('Failed to decode idToken');
    });

    it('should handle errors during user creation', async () => {
      // Mock findUser to return null (user does not exist)
      findUser.mockResolvedValue(null);

      // Mock createSocialUser to throw an error
      createSocialUser.mockImplementation(() => {
        throw new Error('Database error');
      });

      const mockVerifyCallback = jest.fn();

      // Invoke the verify callback with correct arguments
      await new Promise((resolve) => {
        appleStrategyInstance._verify(
          fakeAccessToken,
          fakeRefreshToken,
          tokenset.id_token,
          mockProfile,
          (err, user) => {
            mockVerifyCallback(err, user);
            resolve();
          },
        );
      });

      expect(mockVerifyCallback).toHaveBeenCalledWith(expect.any(Error), undefined);
      expect(mockVerifyCallback.mock.calls[0][0].message).toBe('Database error');
      // Ensure logger.error was called
      expect(logger.error).toHaveBeenCalledWith('[appleLogin]', expect.any(Error));
    });
  });
});
