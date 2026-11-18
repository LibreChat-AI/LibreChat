import 'test/matchMedia.mock';
import React from 'react';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen } from 'test/layout-test-utils';
import PluginPagination from '../PluginPagination';

describe('PluginPagination', () => {
  const onChangePage = jest.fn();

  beforeEach(() => {
    onChangePage.mockClear();
  });

  it.each(['Enter', ' '])('keeps keyboard activation within page bounds for %p', async (key) => {
    const { rerender } = render(
      <PluginPagination currentPage={1} maxPage={5} onChangePage={onChangePage} />,
    );
    const user = userEvent.setup();
    screen.getByRole('button', { name: /prev/i }).focus();
    await user.keyboard(key === 'Enter' ? '{Enter}' : ' ');
    expect(onChangePage).not.toHaveBeenCalled();

    rerender(<PluginPagination currentPage={5} maxPage={5} onChangePage={onChangePage} />);
    screen.getByRole('button', { name: /next/i }).focus();
    await user.keyboard(key === 'Enter' ? '{Enter}' : ' ');
    expect(onChangePage).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('activates each valid page control once for %p', async (key) => {
    render(<PluginPagination currentPage={2} maxPage={5} onChangePage={onChangePage} />);
    const user = userEvent.setup();
    for (const [name, page] of [
      [/prev/i, 1],
      [/next/i, 3],
      [/^4$/, 4],
    ] as const) {
      onChangePage.mockClear();
      screen.getByRole('button', { name }).focus();
      await user.keyboard(key === 'Enter' ? '{Enter}' : ' ');
      expect(onChangePage).toHaveBeenCalledTimes(1);
      expect(onChangePage).toHaveBeenCalledWith(page);
    }
  });

  it('prevents Space scrolling on every page control', () => {
    render(<PluginPagination currentPage={1} maxPage={2} onChangePage={onChangePage} />);
    for (const control of screen.getAllByRole('button')) {
      expect(fireEvent.keyDown(control, { key: ' ' })).toBe(false);
    }
  });

  it('uses the visible localized text as each navigation control name', () => {
    render(<PluginPagination currentPage={1} maxPage={1} onChangePage={onChangePage} />);
    for (const name of [/prev/i, /next/i]) {
      const control = screen.getByRole('button', { name });
      expect(control).toHaveAccessibleName(control.textContent ?? '');
    }
  });

  it('should render the previous button as enabled when not on the first page', () => {
    render(<PluginPagination currentPage={2} maxPage={5} onChangePage={onChangePage} />);
    const prevButton = screen.getByRole('button', { name: /prev/i });
    expect(prevButton).toBeEnabled();
  });

  it('should call onChangePage with the previous page number when the previous button is clicked', async () => {
    render(<PluginPagination currentPage={2} maxPage={5} onChangePage={onChangePage} />);
    const prevButton = screen.getByRole('button', { name: /prev/i });
    await userEvent.click(prevButton);
    expect(onChangePage).toHaveBeenCalledWith(1);
  });

  it('should call onChangePage with the next page number when the next button is clicked', async () => {
    render(<PluginPagination currentPage={2} maxPage={5} onChangePage={onChangePage} />);
    const nextButton = screen.getByRole('button', { name: /next/i });
    await userEvent.click(nextButton);
    expect(onChangePage).toHaveBeenCalledWith(3);
  });

  it('should render the page numbers', () => {
    render(<PluginPagination currentPage={2} maxPage={5} onChangePage={onChangePage} />);
    const pageNumbers = screen.getAllByRole('button', { name: /\d+/ });
    expect(pageNumbers).toHaveLength(5);
    expect(pageNumbers[0]).toHaveTextContent('1');
    expect(pageNumbers[1]).toHaveTextContent('2');
    expect(pageNumbers[2]).toHaveTextContent('3');
    expect(pageNumbers[3]).toHaveTextContent('4');
    expect(pageNumbers[4]).toHaveTextContent('5');
  });

  it('should call onChangePage with the correct page number when a page number button is clicked', async () => {
    render(<PluginPagination currentPage={2} maxPage={5} onChangePage={onChangePage} />);
    const pageNumbers = screen.getAllByRole('button', { name: /\d+/ });
    await userEvent.click(pageNumbers[3]);
    expect(onChangePage).toHaveBeenCalledWith(4);
  });
});
