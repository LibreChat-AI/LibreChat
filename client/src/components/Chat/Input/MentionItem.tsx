import React from 'react';
import { Clock4 } from 'lucide-react';
import { cn } from '~/utils';

export interface MentionItemProps {
  name: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  index: number;
  type?: 'prompt' | 'mention' | 'add-convo' | 'skill';
  icon?: React.ReactNode;
  isActive?: boolean;
  description?: string;
  style?: React.CSSProperties;
}

export default function MentionItem({
  name,
  onClick,
  index,
  icon,
  isActive,
  description,
  style,
  type = 'mention',
}: MentionItemProps) {
  return (
    <button
      type="button"
      style={style}
      tabIndex={index}
      onClick={onClick}
      id={`${type}-item-${index}`}
      className="w-full touch-manipulation"
    >
      <div
        className={cn(
          'text-text-primary group hover:bg-surface-secondary active:bg-surface-active flex min-h-[44px] items-center gap-2 rounded-lg px-2 text-sm font-medium',
          isActive === true ? 'bg-surface-active' : 'bg-transparent',
        )}
      >
        <div className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</div>
        <div className="flex min-w-0 grow items-center justify-between">
          <div className="truncate">
            <span className="font-medium">{name}</span>
            {description != null && description ? (
              <span className="text-text-tertiary ml-2 text-sm font-light">{description}</span>
            ) : null}
          </div>
          <Clock4 size={16} className="ml-2 shrink-0" />
        </div>
      </div>
    </button>
  );
}
