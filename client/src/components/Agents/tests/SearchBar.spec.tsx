import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import SearchBar from '../SearchBar';

// Mock hooks
jest.mock('~/hooks', () => ({
  useDebounce: (value: string) => value, // Return value immediately for testing
  useLocalize: () => (key: string) => key,
}));

describe('SearchBar', () => {
  const mockOnSearch = jest.fn();
  const user = userEvent.setup();

  beforeEach(() => {
    mockOnSearch.mockClear();
  });

  it('focuses the input through its standard floating label', async () => {
    render(<SearchBar value="" onSearch={mockOnSearch} />);
    await user.click(screen.getByText('com_agents_search_aria'));
    expect(screen.getByRole('textbox', { name: 'com_agents_search_aria' })).toHaveFocus();
  });

  it('displays the provided value', () => {
    render(<SearchBar value="test query" onSearch={mockOnSearch} />);

    const input = screen.getByDisplayValue('test query');
    expect(input).toBeInTheDocument();
  });

  it('calls onSearch when user types', async () => {
    render(<SearchBar value="" onSearch={mockOnSearch} />);

    const input = screen.getByRole('textbox');
    await user.type(input, 'test');

    // Should call onSearch for each character due to debounce mock
    expect(mockOnSearch).toHaveBeenCalled();
  });

  it('shows clear button when there is text', () => {
    render(<SearchBar value="test" onSearch={mockOnSearch} />);

    const clearButton = screen.getByRole('button', { name: 'com_agents_clear_search' });
    expect(clearButton).toBeInTheDocument();
  });

  it('does not show clear button when text is empty', () => {
    render(<SearchBar value="" onSearch={mockOnSearch} />);

    const clearButton = screen.queryByRole('button', { name: 'com_agents_clear_search' });
    expect(clearButton).not.toBeInTheDocument();
  });

  it('clears search when clear button is clicked', async () => {
    render(<SearchBar value="test" onSearch={mockOnSearch} />);

    const input = screen.getByRole('textbox');
    const clearButton = screen.getByRole('button', { name: 'com_agents_clear_search' });

    // Verify initial state
    expect(input).toHaveValue('test');

    await user.click(clearButton);

    // Verify onSearch is called and input is cleared
    expect(mockOnSearch).toHaveBeenCalledWith('');
    expect(input).toHaveValue('');
  });

  it('updates internal state when value prop changes', () => {
    const { rerender } = render(<SearchBar value="initial" onSearch={mockOnSearch} />);

    expect(screen.getByDisplayValue('initial')).toBeInTheDocument();

    rerender(<SearchBar value="updated" onSearch={mockOnSearch} />);

    expect(screen.getByDisplayValue('updated')).toBeInTheDocument();
  });

  it('has proper accessibility attributes', () => {
    render(<SearchBar value="" onSearch={mockOnSearch} />);

    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-label', 'com_agents_search_aria');
  });

  it('prevents form submission on clear button click', async () => {
    const handleSubmit = jest.fn();

    render(
      <form onSubmit={handleSubmit}>
        <SearchBar value="test" onSearch={mockOnSearch} />
      </form>,
    );

    const clearButton = screen.getByRole('button', { name: 'com_agents_clear_search' });
    await user.click(clearButton);

    expect(handleSubmit).not.toHaveBeenCalled();
  });

  it('handles rapid typing correctly', async () => {
    render(<SearchBar value="" onSearch={mockOnSearch} />);

    const input = screen.getByRole('textbox');

    // Type multiple characters quickly
    await user.type(input, 'quick');

    // Should handle all characters
    expect(input).toHaveValue('quick');
  });

  it('maintains focus after clear button click', async () => {
    render(<SearchBar value="test" onSearch={mockOnSearch} />);

    const input = screen.getByRole('textbox');
    const clearButton = screen.getByRole('button', { name: 'com_agents_clear_search' });

    input.focus();
    await user.click(clearButton);

    expect(input).toHaveFocus();
  });
});
