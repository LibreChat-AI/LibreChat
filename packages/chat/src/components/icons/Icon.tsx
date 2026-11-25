import { memo, useState, useEffect } from 'react';
import { cn, UserIcon, pxToRem, useAvatar, useLocalize } from '@librechat/client';
import type { NamedExoticComponent, ReactNode } from 'react';
import type { IconProps } from './types';
import MessageEndpointIcon from './MessageEndpointIcon';
import { useMessagePartsHost } from '../../react/host';

type ResolvedAvatar = { type: 'image'; src: string } | { type: 'fallback' };

/**
 * Caches the resolved avatar decision per user ID.
 * Invalidated when `user.avatar` changes (e.g., settings upload).
 * Tracks failed image URLs so they fall back to SVG permanently for the session.
 */
const avatarCache = new Map<
  string,
  { avatar: string; avatarSrc: string; resolved: ResolvedAvatar }
>();
const failedUrls = new Set<string>();

function resolveAvatar(userId: string, userAvatar: string, avatarSrc: string): ResolvedAvatar {
  if (!userId) {
    const imgSrc = userAvatar || avatarSrc;
    return imgSrc && !failedUrls.has(imgSrc)
      ? { type: 'image', src: imgSrc }
      : { type: 'fallback' };
  }

  const cached = avatarCache.get(userId);
  if (cached && cached.avatar === userAvatar && cached.avatarSrc === avatarSrc) {
    return cached.resolved;
  }

  const imgSrc = userAvatar || avatarSrc;
  const resolved: ResolvedAvatar =
    imgSrc && !failedUrls.has(imgSrc) ? { type: 'image', src: imgSrc } : { type: 'fallback' };

  avatarCache.set(userId, { avatar: userAvatar, avatarSrc, resolved });
  return resolved;
}

function markAvatarFailed(userId: string, src: string): ResolvedAvatar {
  failedUrls.add(src);
  const fallback: ResolvedAvatar = { type: 'fallback' };
  const cached = avatarCache.get(userId);
  if (cached) {
    avatarCache.set(userId, { ...cached, resolved: fallback });
  }
  return fallback;
}

type UserAvatarProps = {
  /** The image's accessible name. */
  alt: string;
  size: number;
  avatar: string;
  avatarSrc: string;
  userId: string;
  username: string;
  className?: string;
};

const UserAvatar: NamedExoticComponent<UserAvatarProps> = memo(
  ({ size, avatar, avatarSrc, userId, username, alt, className }: UserAvatarProps): ReactNode => {
    const [resolved, setResolved] = useState(() => resolveAvatar(userId, avatar, avatarSrc));

    useEffect(() => {
      setResolved(resolveAvatar(userId, avatar, avatarSrc));
    }, [userId, avatar, avatarSrc]);

    return (
      <div
        title={username}
        style={{ width: pxToRem(size), height: pxToRem(size) }}
        className={cn('relative flex items-center justify-center', className ?? '')}
      >
        {resolved.type === 'image' ? (
          <img
            className="rounded-full"
            src={resolved.src}
            alt={alt}
            onError={() => setResolved(markAvatarFailed(userId, resolved.src))}
          />
        ) : (
          <div
            style={{
              width: pxToRem(20),
              height: pxToRem(20),
            }}
            className="bg-avatar-fill text-avatar-text ring-avatar-edge/10 relative flex h-9 w-9 items-center justify-center rounded-sm p-1 ring-1"
          >
            <UserIcon />
          </div>
        )}
      </div>
    );
  },
);

UserAvatar.displayName = 'UserAvatar';

/** An author's icon: the signed-in user's avatar on their own messages, else the endpoint's. */
const Icon: NamedExoticComponent<IconProps> = memo((props: IconProps): ReactNode => {
  /** The host's user, which is nobody on a public share link: the icon then draws a plain glyph. */
  const user = useMessagePartsHost().useUser();
  const { size = 30, isCreatedByUser } = props;

  const avatarSrc = useAvatar(user);
  const localize = useLocalize();

  if (isCreatedByUser) {
    const username = user?.name ?? user?.username ?? localize('com_nav_user');
    return (
      <UserAvatar
        size={size}
        avatarSrc={avatarSrc}
        username={username}
        userId={user?.id ?? ''}
        avatar={user?.avatar ?? ''}
        alt={localize('com_ui_avatar')}
        className={props.className}
      />
    );
  }
  return <MessageEndpointIcon {...props} />;
});

Icon.displayName = 'Icon';

export default Icon;
