import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataTableSearch } from './DataTableSearch';

// Mock the cn utility
jest.mock('~/utils', () => ({
  cn: (...classes: (string | undefined | boolean)[]) => classes.filter(Boolean).join(' '),
}));

// Mock the Input component

jest.mock('../Input', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactModule = require('react');
  return {
    Input: ReactModule.forwardRef(function MockInput(
      props: {
        id?: string;
        value?: string;
        onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
        disabled?: boolean;
        'aria-label'?: string;
        'aria-describedby'?: string;
        placeholder?: string;
        className?: string;
      },
      ref: React.Ref<HTMLInputElement>,
    ) {
      return ReactModule.createElement('input', {
        ref,
        id: props.id,
        value: props.value,
        onChange: props.onChange,
        disabled: props.disabled,
        'aria-label': props['aria-label'],
        'aria-describedby': props['aria-describedby'],
        placeholder: props.placeholder,
        className: props.className,
        'data-testid': 'search-input',
      });
    }),
  };
});

describe('DataTableSearch', () => {
  it('should render input with correct placeholder', () => {
    render(<DataTableSearch value="" onChange={jest.fn()} placeholder="Search items..." />);

    const input = screen.getByTestId('search-input');
    expect(input).toHaveAttribute('placeholder', 'Search items...');
  });

  it('should render with default placeholder when not provided', () => {
    render(<DataTableSearch value="" onChange={jest.fn()} />);

    const input = screen.getByTestId('search-input');
    // Default placeholder is from localize function which returns the key
    expect(input).toHaveAttribute('placeholder', 'com_ui_search');
  });

  it('should display the current value', () => {
    render(<DataTableSearch value="test query" onChange={jest.fn()} />);

    const input = screen.getByTestId('search-input');
    expect(input).toHaveValue('test query');
  });

  it('should call onChange when user types', () => {
    const mockOnChange = jest.fn();
    render(<DataTableSearch value="" onChange={mockOnChange} />);

    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'new search' } });

    expect(mockOnChange).toHaveBeenCalledWith('new search');
  });

  it('should have accessible label (sr-only)', () => {
    render(<DataTableSearch value="" onChange={jest.fn()} />);

    // The label should be present but visually hidden (sr-only class)
    const label = screen.getByText('com_ui_search_table');
    expect(label).toHaveClass('sr-only');
  });

  it('should have aria-label on input', () => {
    render(<DataTableSearch value="" onChange={jest.fn()} />);

    const input = screen.getByTestId('search-input');
    expect(input).toHaveAttribute('aria-label', 'com_ui_search_table');
  });

  it('should have aria-describedby linking to description', () => {
    render(<DataTableSearch value="" onChange={jest.fn()} />);

    const input = screen.getByTestId('search-input');

    // Description should be present
    const description = screen.getByText('com_ui_search_table_description');
    expect(input).toHaveAttribute('aria-describedby', description.id);
    expect(description).toHaveClass('sr-only');
  });

  it('should respect disabled prop', () => {
    render(<DataTableSearch value="" onChange={jest.fn()} disabled={true} />);

    const input = screen.getByTestId('search-input');
    expect(input).toBeDisabled();
  });

  it('should not be disabled by default', () => {
    render(<DataTableSearch value="" onChange={jest.fn()} />);

    const input = screen.getByTestId('search-input');
    expect(input).not.toBeDisabled();
  });

  it('should apply custom className', () => {
    render(<DataTableSearch value="" onChange={jest.fn()} className="custom-class" />);

    const input = screen.getByTestId('search-input');
    expect(input.className).toContain('custom-class');
  });

  it('should apply default styling classes', () => {
    render(<DataTableSearch value="" onChange={jest.fn()} />);

    const input = screen.getByTestId('search-input');
    expect(input.className).toContain('h-11');
    /* The field sits flush inside the table's toolbar, so it carries no chrome of
       its own and leaves room for the leading search icon. */
    expect(input.className).toContain('bg-transparent');
    expect(input.className).toContain('border-0');
    expect(input.className).toContain('pl-9');
  });

  it('should have correct id for label association', () => {
    render(<DataTableSearch value="" onChange={jest.fn()} />);

    const input = screen.getByTestId('search-input');
    const label = screen.getByText('com_ui_search_table');

    expect(input.id).not.toBe('');
    expect(label).toHaveAttribute('for', input.id);
  });

  it('should handle empty string onChange', () => {
    const mockOnChange = jest.fn();
    render(<DataTableSearch value="existing" onChange={mockOnChange} />);

    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: '' } });

    expect(mockOnChange).toHaveBeenCalledWith('');
  });

  it('should handle special characters in search', () => {
    const mockOnChange = jest.fn();
    render(<DataTableSearch value="" onChange={mockOnChange} />);

    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: 'test@#$%^&*()' } });

    expect(mockOnChange).toHaveBeenCalledWith('test@#$%^&*()');
  });

  it('should handle long text input', () => {
    const mockOnChange = jest.fn();
    const longText = 'a'.repeat(1000);
    render(<DataTableSearch value="" onChange={mockOnChange} />);

    const input = screen.getByTestId('search-input');
    fireEvent.change(input, { target: { value: longText } });

    expect(mockOnChange).toHaveBeenCalledWith(longText);
  });

  it('should be memoized (displayName check)', () => {
    expect(DataTableSearch.displayName).toBe('DataTableSearch');
  });
});
