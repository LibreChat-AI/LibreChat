import type { FC } from 'react';
import { cn } from '~/utils';

type MenuItemProps = {
  title: string;
  value?: string;
  selected: boolean;
  description?: string;
  onClick?: () => void;
  hoverCondition?: boolean;
  hoverContent?: React.ReactNode;
  children?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  textClassName?: string;
  // hoverContent?: string;
} & Record<string, unknown>;

const MenuItem: FC<MenuItemProps> = ({
  title,
  // value,
  description,
  selected,
  // hoverCondition = true,
  // hoverContent,
  icon,
  className = '',
  textClassName = '',
  children,
  onClick,
  ...rest
}) => {
  return (
    <div
      id={selected ? 'selected-endpoint' : undefined}
      role="option"
      aria-selected={selected}
      aria-label={title}
      data-testid="chat-menu-item"
      className={cn(
        'group hover:bg-surface-hover m-1.5 flex cursor-pointer gap-2 rounded px-5 py-2.5 !pr-3 text-sm !opacity-100 focus:ring-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 md:min-w-[240px]',
        className || '',
      )}
      tabIndex={0} // Change to 0 to make it focusable
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (onClick) {
            onClick();
          }
        }
      }}
      {...rest}
    >
      <div className="flex grow items-center justify-between gap-2">
        <div>
          <div className={cn('flex items-center gap-1')}>
            {icon != null ? icon : null}
            <div className={cn('truncate', textClassName)}>
              {title}
              <div className="text-text-tertiary">{description}</div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {children}
          {selected && (
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="icon-md block"
            >
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12ZM16.0755 7.93219C16.5272 8.25003 16.6356 8.87383 16.3178 9.32549L11.5678 16.0755C11.3931 16.3237 11.1152 16.4792 10.8123 16.4981C10.5093 16.517 10.2142 16.3973 10.0101 16.1727L7.51006 13.4227C7.13855 13.014 7.16867 12.3816 7.57733 12.0101C7.98598 11.6386 8.61843 11.6687 8.98994 12.0773L10.6504 13.9039L14.6822 8.17451C15 7.72284 15.6238 7.61436 16.0755 7.93219Z"
                fill="currentColor"
              />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
};

export default MenuItem;
