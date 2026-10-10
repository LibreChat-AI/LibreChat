import React, { useState, useMemo, useCallback } from 'react';
import type { TUser } from 'librechat-data-provider';
import { Skeleton } from './Skeleton';
import { useAvatar } from '~/hooks';
import { pxToRem } from '~/utils';
import { UserIcon } from '~/svgs';

export interface AvatarProps {
  user?: TUser;
  size?: number;
  className?: string;
  alt?: string;
  showDefaultWhenEmpty?: boolean;
}

const Avatar: React.FC<AvatarProps> = ({
  user,
  size = 32,
  className = '',
  alt,
  showDefaultWhenEmpty = true,
}) => {
  const avatarSrc = useAvatar(user);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);

  const avatarSeed = useMemo(
    () => user?.avatar || user?.username || user?.email || '',
    [user?.avatar, user?.username, user?.email],
  );

  const altText = useMemo(
    () => alt || `${user?.name || user?.username || user?.email || ''}'s avatar`,
    [alt, user?.name, user?.username, user?.email],
  );

  const imageSrc = useMemo(() => {
    if (!avatarSeed || imageError) return '';
    return (user?.avatar ?? '') || avatarSrc || '';
  }, [user?.avatar, avatarSrc, avatarSeed, imageError]);

  const handleImageLoad = useCallback(() => {
    setImageLoaded(true);
  }, []);

  const handleImageError = useCallback(() => {
    setImageError(true);
    setImageLoaded(false);
  }, []);

  const DefaultAvatar = useCallback(
    () => (
      <div
        style={{
          width: pxToRem(size),
          height: pxToRem(size),
        }}
        className={`bg-avatar-fill text-avatar-text ring-avatar-edge/10 relative flex items-center justify-center rounded-full p-1 ring-1 ${className}`}
        aria-hidden="true"
      >
        <UserIcon />
      </div>
    ),
    [size, className],
  );

  if (avatarSeed.length === 0 && showDefaultWhenEmpty) {
    return <DefaultAvatar />;
  }

  if (avatarSeed.length > 0 && !imageError) {
    return (
      <div className="relative" style={{ width: pxToRem(size), height: pxToRem(size) }}>
        {!imageLoaded && (
          <Skeleton
            className="rounded-full"
            style={{ width: pxToRem(size), height: pxToRem(size) }}
          />
        )}

        <img
          style={{
            width: pxToRem(size),
            height: pxToRem(size),
            display: imageLoaded ? 'block' : 'none',
          }}
          className={`rounded-full ${className}`}
          src={imageSrc}
          alt={altText}
          onLoad={handleImageLoad}
          onError={handleImageError}
        />
      </div>
    );
  }

  if (imageError && showDefaultWhenEmpty) {
    return <DefaultAvatar />;
  }

  return null;
};

export default Avatar;
