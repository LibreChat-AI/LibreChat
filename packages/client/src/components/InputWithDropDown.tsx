import * as React from 'react';
import { Input } from './Input';
import { cn } from '~/utils';

export type InputWithDropdownProps = React.InputHTMLAttributes<HTMLInputElement> & {
  options: string[];
  onSelect?: (value: string) => void;
};

const InputWithDropdown: React.ForwardRefExoticComponent<
  React.InputHTMLAttributes<HTMLInputElement> & {
    options: string[];
    onSelect?: (value: string) => void;
  } & React.RefAttributes<HTMLInputElement>
> = React.forwardRef<HTMLInputElement, InputWithDropdownProps>(
  ({ className, options, onSelect, ...props }, ref) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const [inputValue, setInputValue] = React.useState((props.value as string) || '');
    const [highlightedIndex, setHighlightedIndex] = React.useState(-1);
    const inputRef = React.useRef<HTMLInputElement>(null);

    const handleSelect = (value: string) => {
      setInputValue(value);
      setIsOpen(false);
      setHighlightedIndex(-1);
      if (onSelect) {
        onSelect(value);
      }
      if (props.onChange) {
        props.onChange({ target: { value } } as React.ChangeEvent<HTMLInputElement>);
      }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setInputValue(e.target.value);
      if (props.onChange) {
        props.onChange(e);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!isOpen) {
            setIsOpen(true);
          } else {
            setHighlightedIndex((prevIndex) =>
              prevIndex < options.length - 1 ? prevIndex + 1 : prevIndex,
            );
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightedIndex((prevIndex) => (prevIndex > 0 ? prevIndex - 1 : 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (isOpen && highlightedIndex !== -1) {
            handleSelect(options[highlightedIndex]);
          }
          setIsOpen(false);
          break;
        case 'Escape':
          setIsOpen(false);
          setHighlightedIndex(-1);
          break;
      }
    };

    React.useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (inputRef.current && !inputRef.current.contains(event.target as Node)) {
          setIsOpen(false);
          setHighlightedIndex(-1);
        }
      };

      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }, []);

    return (
      <div className="relative" ref={inputRef}>
        <div className="relative">
          <Input
            {...props}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            aria-haspopup="listbox"
            aria-controls="dropdown-list"
            className={cn('bg-surface-secondary', className ?? '')}
            ref={ref}
          />
          <button
            type="button"
            className="text-text-tertiary hover:text-text-secondary focus-visible:ring-focus-control absolute inset-y-0 right-0 flex items-center rounded-md px-2 focus-visible:ring-1 focus-visible:outline-hidden"
            onClick={() => setIsOpen(!isOpen)}
            aria-label={isOpen ? 'Close dropdown' : 'Open dropdown'}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        </div>
        {isOpen && (
          <ul
            id="dropdown-list"
            role="listbox"
            className="border-border-medium bg-surface-secondary focus:ring-focus-control absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border shadow-lg focus:ring-1 focus:ring-inset"
          >
            {options.map((option, index) => (
              <li
                key={index}
                role="option"
                aria-selected={index === highlightedIndex}
                className={cn(
                  'cursor-pointer rounded-md px-3 py-2',
                  'focus:bg-surface-tertiary focus:ring-focus-control focus:ring-1 focus:outline-hidden focus:ring-inset',
                  index === highlightedIndex
                    ? 'bg-surface-active text-text-primary'
                    : 'text-text-secondary hover:bg-surface-tertiary',
                )}
                onClick={() => handleSelect(option)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelect(option);
                  }
                }}
                tabIndex={0}
              >
                {option}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);

InputWithDropdown.displayName = 'InputWithDropdown';

export default InputWithDropdown;
