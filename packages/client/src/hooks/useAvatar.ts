import { useMemo } from 'react';
import { createAvatar } from '@dicebear/core';
import { initials } from '@dicebear/collection';
import type { TUser } from 'librechat-data-provider';

const avatarCache: Record<string, string> = {};

const useAvatar = (user: TUser | undefined): string => {
  return useMemo(() => {
    const { username, name } = user ?? {};
    const seed = name || username;
    if (!seed) {
      return '';
    }

    if (user?.avatar && user?.avatar !== '') {
      return user.avatar;
    }

    if (avatarCache[seed]) {
      return avatarCache[seed];
    }

    const avatar = createAvatar(initials, {
      seed,
      fontFamily: ['Verdana'],
      fontSize: 36,
      backgroundType: ['solid'],
      backgroundColor: [
        'd81b60',
        '8e24aa',
        '5e35b1',
        '3949ab',
        'DB3733',
        '1B79CC',
        '027CB8',
        '008291',
        '008577',
        '58802F',
        '8A761D',
        '9C6D00',
        'B06200',
        'D1451A',
      ],
      textColor: ['ffffff'],
    });

    let avatarDataUri = '';
    try {
      avatarDataUri = avatar.toDataUri();
      if (avatarDataUri) {
        avatarCache[seed] = avatarDataUri;
      }
    } catch (error) {
      console.error('Failed to generate avatar:', error);
    }

    return avatarDataUri;
  }, [user]);
};

export default useAvatar;
