import { X, Plus } from 'lucide';
import { motion } from 'framer-motion';
import { JSX } from 'react/jsx-runtime';
import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import type React from 'react';
import { MorphIcon } from './MorphIcon';
import { cn } from '~/utils';

interface BadgeProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'onAnimationStart' | 'onDragStart' | 'onDragEnd' | 'onDrag'
  > {
  icon?: LucideIcon;
  label: string;
  id?: string;
  isActive?: boolean;
  isEditing?: boolean;
  isDragging?: boolean;
  isAvailable: boolean;
  isInChat?: boolean;
  onBadgeAction?: () => void;
  onToggle?: () => void;
}

export default function Badge({
  icon: Icon,
  label,
  id,
  isActive = false,
  isEditing = false,
  isDragging = false,
  isAvailable = true,
  isInChat = false,
  onBadgeAction,
  onToggle,
  className,
  ...props
}: BadgeProps): JSX.Element {
  const isMoveable = isEditing && isAvailable;
  const isDisabled = id === '1' && isInChat;

  const handleClick: React.MouseEventHandler<HTMLElement> = (e) => {
    if (isDisabled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (!isEditing && onToggle) {
      e.preventDefault();
      e.stopPropagation();
      onToggle();
    }
  };

  const getWhileTapScale = () => {
    if (isDragging) {
      return 1.1;
    }
    if (isDisabled) {
      return 1;
    }
    return 0.97;
  };

  const { type: buttonType, onClick: customOnClick, ...buttonProps } = props;
  const handleRootClick: React.MouseEventHandler<HTMLElement> = customOnClick
    ? (event) => customOnClick(event as React.MouseEvent<HTMLButtonElement>)
    : handleClick;
  const badgeClassName = cn(
    'group relative inline-flex items-center gap-1.5 rounded-full px-4 py-1.5',
    'border border-border-medium text-sm font-medium transition-shadow',
    '@container-[600px]:w-full size-9 p-2',
    isActive
      ? 'bg-surface-active shadow-md'
      : 'bg-surface-chat shadow-sm hover:bg-surface-hover hover:shadow-md',
    'active:scale-95 active:shadow-inner',
    isMoveable && 'cursor-move',
    isDisabled && 'cursor-not-allowed opacity-50 hover:shadow-sm',
    className,
  );
  const badgeContent = (
    <>
      {Icon && (
        <Icon
          className={cn(
            '@container-[600px]:h-4 @container-[600px]:w-4 relative h-5 w-5',
            !label && 'mx-auto',
          )}
          aria-hidden="true"
        />
      )}
      <span className="@container-[600px]:inline relative hidden">{label}</span>

      {isEditing && !isDragging && (
        <motion.button
          type="button"
          className="@container-[600px]:h-5 @container-[600px]:w-5 absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full bg-surface-secondary-alt text-text-primary shadow-sm"
          aria-label={isAvailable ? `Remove ${label}` : `Restore ${label}`}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          whileTap={{ scale: 0.9 }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onBadgeAction?.();
          }}
        >
          <MorphIcon icon={isAvailable ? X : Plus} className="h-3 w-3" />
        </motion.button>
      )}
    </>
  );

  if (isEditing) {
    return (
      <motion.div
        {...(buttonProps as React.ComponentProps<typeof motion.div>)}
        onClick={handleRootClick}
        className={badgeClassName}
        animate={{
          scale: isDragging ? 1.1 : 1,
          boxShadow: isDragging ? '0 10px 25px rgba(0,0,0,0.1)' : undefined,
        }}
        whileTap={{ scale: getWhileTapScale() }}
        transition={{ type: 'tween', duration: 0.1, ease: 'easeOut' }}
      >
        {badgeContent}
      </motion.div>
    );
  }

  return (
    <motion.button
      type={buttonType ?? 'button'}
      onClick={handleRootClick}
      className={badgeClassName}
      animate={{
        scale: isDragging ? 1.1 : 1,
        boxShadow: isDragging ? '0 10px 25px rgba(0,0,0,0.1)' : undefined,
      }}
      whileTap={{ scale: getWhileTapScale() }}
      transition={{ type: 'tween', duration: 0.1, ease: 'easeOut' }}
      {...(buttonProps as React.ComponentProps<typeof motion.button>)}
    >
      {badgeContent}
    </motion.button>
  );
}
