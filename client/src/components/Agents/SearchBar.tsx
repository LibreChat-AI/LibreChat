import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { Button, FilterInput } from '@librechat/client';
import { useDebounce, useLocalize } from '~/hooks';

/**
 * Props for the SearchBar component
 */
interface SearchBarProps {
  /** Current search query value */
  value: string;
  /** Callback fired when the search query changes */
  onSearch: (query: string) => void;
  /**
   * Additional CSS classes for the wrapper. The component carries no width cap of
   * its own, so the caller owns sizing (e.g. `max-w-[420px]` in a toolbar row).
   */
  className?: string;
}

/**
 * SearchBar - Component for searching agents with debounced input
 *
 * Provides a search input with clear button and debounced search functionality.
 * Includes proper ARIA attributes for accessibility and visual indicators.
 * Uses 300ms debounce delay to prevent excessive API calls during typing.
 */
const SearchBar: React.FC<SearchBarProps> = ({ value, onSearch, className = '' }) => {
  const localize = useLocalize();
  const [searchTerm, setSearchTerm] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search value (300ms delay)
  const debouncedSearchTerm = useDebounce(searchTerm, 300);

  // Update internal state when props change
  useEffect(() => {
    setSearchTerm(value);
  }, [value]);

  // Trigger search when debounced value changes
  useEffect(() => {
    // Only trigger search if the debounced value matches current searchTerm
    // This prevents stale debounced values from triggering after clear
    if (debouncedSearchTerm !== value && debouncedSearchTerm === searchTerm) {
      onSearch(debouncedSearchTerm);
    }
  }, [debouncedSearchTerm, onSearch, value, searchTerm]);

  /**
   * Handle search input changes
   *
   * @param e - Input change event
   */
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  };

  /**
   * Clear the search input and reset results
   */
  const handleClear = useCallback(() => {
    // Immediately call parent onSearch to clear the URL parameter
    onSearch('');
    // Also clear local state
    setSearchTerm('');
    inputRef.current?.focus();
  }, [onSearch]);

  return (
    <div className={`relative w-full ${className}`} role="search">
      <FilterInput
        inputId="agent-search"
        label={localize('com_agents_search_aria')}
        type="text"
        ref={inputRef}
        value={searchTerm}
        onChange={handleChange}
        className="focus-visible:ring-text-primary pe-10 focus-visible:ring-2 focus-visible:ring-inset"
        aria-describedby="search-instructions search-results-count"
        autoComplete="off"
        spellCheck="false"
      />

      {/* Hidden instructions for screen readers */}
      <div id="search-instructions" className="sr-only">
        {localize('com_agents_search_instructions')}
      </div>
      {/* Show clear button only when search has value - Google style */}
      {searchTerm && (
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={handleClear}
          /* `ghost` only colours its hover state, so the glyph would inherit the
             document's colour and disappear against a dark surface. */
          className="text-text-secondary absolute end-0.5 top-1/2 -translate-y-1/2 rounded-md transition-none"
          aria-label={localize('com_agents_clear_search')}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
};

export default SearchBar;
