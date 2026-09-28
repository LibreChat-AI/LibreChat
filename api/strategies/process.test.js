const { FileSources } = require('librechat-data-provider');
const { handleExistingUser, createSocialUser } = require('./process');

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

jest.mock('~/server/services/Files/images/avatar', () => ({
  resizeAvatar: jest.fn(),
}));

jest.mock('~/models', () => ({
  updateUser: jest.fn(),
  createUser: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({}),
}));

jest.mock('@librechat/api', () => ({
  getBalanceConfig: jest.fn(() => ({
    enabled: false,
  })),
}));

const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { resizeAvatar } = require('~/server/services/Files/images/avatar');
const { updateUser, createUser, getUserById } = require('~/models');

describe('handleExistingUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CDN_PROVIDER = FileSources.local;
  });

  it('should not process the avatar when the provider supplies no avatarUrl (local storage)', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: null,
    };

    await handleExistingUser(oldUser, null);

    expect(resizeAvatar).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('should not process the avatar when the provider supplies no avatarUrl (non-local storage)', async () => {
    process.env.CDN_PROVIDER = FileSources.s3;
    const oldUser = {
      _id: 'user123',
      avatar: null,
    };

    await handleExistingUser(oldUser, undefined);

    expect(resizeAvatar).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('should still update the email when the provider supplies no avatarUrl', async () => {
    process.env.CDN_PROVIDER = FileSources.s3;
    const oldUser = {
      _id: 'user123',
      avatar: null,
      email: 'old@example.com',
    };

    await handleExistingUser(oldUser, null, undefined, 'new@example.com');

    expect(resizeAvatar).not.toHaveBeenCalled();
    expect(updateUser).toHaveBeenCalledWith('user123', { email: 'new@example.com' });
  });

  it('should handle null avatar without throwing error', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: null,
    };
    const avatarUrl = 'https://example.com/avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should handle undefined avatar without throwing error', async () => {
    const oldUser = {
      _id: 'user123',
      // avatar is undefined
    };
    const avatarUrl = 'https://example.com/avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should not update avatar if it has manual=true flag', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: 'https://example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/new-avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).not.toHaveBeenCalled();
  });

  it('should update avatar for local storage when avatar has no manual flag', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: 'https://example.com/old-avatar.png',
    };
    const avatarUrl = 'https://example.com/new-avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should process avatar for non-local storage', async () => {
    process.env.CDN_PROVIDER = 's3';

    const mockProcessAvatar = jest.fn().mockResolvedValue('processed-avatar-url');
    getStrategyFunctions.mockReturnValue({ processAvatar: mockProcessAvatar });
    resizeAvatar.mockResolvedValue(Buffer.from('resized-image'));

    const oldUser = {
      _id: 'user123',
      avatar: null,
    };
    const avatarUrl = 'https://example.com/avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(resizeAvatar).toHaveBeenCalledWith({
      userId: 'user123',
      input: avatarUrl,
    });
    expect(mockProcessAvatar).toHaveBeenCalledWith({
      buffer: Buffer.from('resized-image'),
      userId: 'user123',
      manual: 'false',
    });
    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: 'processed-avatar-url' });
  });

  it('should not update if avatar already has manual flag in non-local storage', async () => {
    process.env.CDN_PROVIDER = 's3';

    const oldUser = {
      _id: 'user123',
      avatar: 'https://cdn.example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/new-avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(resizeAvatar).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('should handle avatar with query parameters but without manual flag', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: 'https://example.com/avatar.png?size=large&format=webp',
    };
    const avatarUrl = 'https://example.com/new-avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should handle empty string avatar', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: '',
    };
    const avatarUrl = 'https://example.com/avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should handle avatar with manual=false parameter', async () => {
    const oldUser = {
      _id: 'user123',
      avatar: 'https://example.com/avatar.png?manual=false',
    };
    const avatarUrl = 'https://example.com/new-avatar.png';

    await handleExistingUser(oldUser, avatarUrl);

    expect(updateUser).toHaveBeenCalledWith('user123', { avatar: avatarUrl });
  });

  it('should handle oldUser being null gracefully', async () => {
    const avatarUrl = 'https://example.com/avatar.png';

    // This should throw an error when trying to access oldUser._id
    await expect(handleExistingUser(null, avatarUrl)).rejects.toThrow();
  });

  it('should update email when it has changed', async () => {
    const oldUser = {
      _id: 'user123',
      email: 'old@example.com',
      avatar: 'https://example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/avatar.png';
    const newEmail = 'new@example.com';

    await handleExistingUser(oldUser, avatarUrl, {}, newEmail);

    expect(updateUser).toHaveBeenCalledWith('user123', { email: 'new@example.com' });
  });

  it('should update both avatar and email when both have changed', async () => {
    const oldUser = {
      _id: 'user123',
      email: 'old@example.com',
      avatar: null,
    };
    const avatarUrl = 'https://example.com/new-avatar.png';
    const newEmail = 'new@example.com';

    await handleExistingUser(oldUser, avatarUrl, {}, newEmail);

    expect(updateUser).toHaveBeenCalledWith('user123', {
      avatar: avatarUrl,
      email: 'new@example.com',
    });
  });

  it('should not update email when it has not changed', async () => {
    const oldUser = {
      _id: 'user123',
      email: 'same@example.com',
      avatar: 'https://example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/avatar.png';
    const sameEmail = 'same@example.com';

    await handleExistingUser(oldUser, avatarUrl, {}, sameEmail);

    expect(updateUser).not.toHaveBeenCalled();
  });

  it('should trim email before comparison and update', async () => {
    const oldUser = {
      _id: 'user123',
      email: 'test@example.com',
      avatar: 'https://example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/avatar.png';
    const newEmailWithSpaces = '  newemail@example.com  ';

    await handleExistingUser(oldUser, avatarUrl, {}, newEmailWithSpaces);

    expect(updateUser).toHaveBeenCalledWith('user123', { email: 'newemail@example.com' });
  });

  it('should not update when email parameter is not provided', async () => {
    const oldUser = {
      _id: 'user123',
      email: 'test@example.com',
      avatar: 'https://example.com/avatar.png?manual=true',
    };
    const avatarUrl = 'https://example.com/avatar.png';

    await handleExistingUser(oldUser, avatarUrl, {});

    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe('createSocialUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CDN_PROVIDER = FileSources.s3;
    createUser.mockResolvedValue('newUser123');
    getUserById.mockResolvedValue({ _id: 'newUser123' });
  });

  it('should not process the avatar when the provider supplies no avatarUrl', async () => {
    await createSocialUser({
      email: 'user@privaterelay.appleid.com',
      avatarUrl: null,
      provider: 'apple',
      providerKey: 'appleId',
      providerId: 'apple-sub-123',
      username: 'user',
      name: 'User',
      emailVerified: true,
    });

    expect(resizeAvatar).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
    expect(getUserById).toHaveBeenCalledWith('newUser123');
  });
});
