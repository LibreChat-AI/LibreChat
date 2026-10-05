import React from 'react';
import { Search } from 'lucide-react';
import { JSX } from 'react/jsx-runtime';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const AnimatedSearchInput = ({
  value,
  onChange,
  isSearching: searching,
  placeholder,
}: {
  value?: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isSearching?: boolean;
  placeholder: string;
}): JSX.Element => {
  const isSearching = searching === true;
  const hasValue = value != null && value.length > 0;
  const localize = useLocalize();

  return (
    <div className="relative w-full">
      <div className="relative rounded-lg transition-all duration-500 ease-in-out">
        <div className="relative">
          {/* Icon on the left */}
          <div className="absolute top-1/2 left-3 z-50 -translate-y-1/2">
            <Search
              className={cn(
                `h-4 w-4 transition-all duration-500 ease-in-out`,
                isSearching && hasValue ? 'text-accent-primary' : 'text-text-secondary',
              )}
            />
          </div>

          {/* Input field */}
          <input
            type="text"
            value={value}
            onChange={onChange}
            placeholder={placeholder}
            aria-label={localize('com_ui_search')}
            className={`peer bg-surface-secondary placeholder:text-text-secondary focus:ring-focus-control relative z-20 w-full rounded-lg py-2 pl-10 outline-hidden backdrop-blur-xs transition-all duration-500 ease-in-out`}
          />

          {/* Gradient overlay */}
          <div
            className={`from-accent-primary/20 via-accent-primary/10 to-accent-primary/20 pointer-events-none absolute inset-0 z-20 rounded-lg bg-gradient-to-r transition-all duration-500 ease-in-out ${isSearching && hasValue ? 'opacity-100 blur-xs' : 'opacity-0 blur-none'} `}
          />

          {/* Animated loading indicator */}
          <div
            className={`absolute top-1/2 right-3 z-20 -translate-y-1/2 transition-all duration-500 ease-in-out ${isSearching && hasValue ? 'scale-100 opacity-100' : 'scale-0 opacity-0'} `}
          >
            <div className="relative h-2 w-2">
              <div className="bg-accent-primary/60 absolute inset-0 animate-ping rounded-full" />
              <div className="bg-accent-primary absolute inset-0 rounded-full" />
            </div>
          </div>
        </div>
      </div>

      {/* Outer glow effect */}
      <div
        className={`absolute -inset-8 -z-10 transition-all duration-700 ease-in-out ${isSearching && hasValue ? 'scale-105 opacity-100' : 'scale-100 opacity-0'} `}
      >
        <div className="absolute inset-0">
          <div
            className={`bg-gradient-radial from-accent-primary/10 absolute inset-0 to-transparent transition-opacity duration-700 ease-in-out ${isSearching && hasValue ? 'animate-pulse-slow opacity-100' : 'opacity-0'} `}
          />
          <div
            className={`from-accent-primary/5 via-accent-primary/10 to-accent-primary/5 absolute inset-0 bg-gradient-to-r blur-xl transition-all duration-700 ease-in-out ${isSearching && hasValue ? 'animate-gradient-x opacity-100' : 'opacity-0'} `}
          />
        </div>
      </div>
      <div
        className={`from-accent-primary/10 via-accent-primary/10 to-accent-primary/10 absolute inset-0 -z-20 scale-100 bg-gradient-to-r opacity-0 blur-xl transition-all duration-500 ease-in-out peer-focus:scale-105 peer-focus:opacity-100`}
      />
    </div>
  );
};

export default AnimatedSearchInput;
