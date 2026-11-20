import 'test/matchMedia.mock';
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import { Provider as JotaiProvider, createStore } from 'jotai';
import UiScaleSelector from './UiScaleSelector';

const renderSelector = () => {
  const store = createStore();
  return render(
    <JotaiProvider store={store}>
      <UiScaleSelector />
    </JotaiProvider>,
  );
};

const settleReflow = () => {
  act(() => {
    jest.advanceTimersByTime(300);
  });
};

const appliedScale = () => document.documentElement.style.getPropertyValue('--ui-scale');

describe('UiScaleSelector', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    localStorage.clear();
    document.documentElement.style.removeProperty('--ui-scale');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('labels both steppers for assistive technology', () => {
    const { getByLabelText } = renderSelector();

    expect(getByLabelText('Decrease UI scale')).toBeInTheDocument();
    expect(getByLabelText('Increase UI scale')).toBeInTheDocument();
  });

  it('shows the new value immediately but holds the reflow until clicks stop', () => {
    const { getByTestId, getByText } = renderSelector();

    fireEvent.click(getByTestId('ui-scale-increase'));

    expect(getByText('110%')).toBeInTheDocument();
    expect(appliedScale()).toBe('');

    settleReflow();

    expect(appliedScale()).toBe('1.1');
    expect(localStorage.getItem('uiScale')).toBe('1.1');
  });

  it('keeps stepping through the stops while clicks are rapid, applying once', () => {
    const { getByTestId, getByText } = renderSelector();

    fireEvent.click(getByTestId('ui-scale-increase'));
    fireEvent.click(getByTestId('ui-scale-increase'));
    fireEvent.click(getByTestId('ui-scale-increase'));

    expect(getByText('150%')).toBeInTheDocument();
    expect(appliedScale()).toBe('');

    settleReflow();

    expect(appliedScale()).toBe('1.5');
  });

  it('steps down through the stops', () => {
    const { getByTestId, getByText } = renderSelector();

    fireEvent.click(getByTestId('ui-scale-decrease'));
    settleReflow();

    expect(getByText('90%')).toBeInTheDocument();
    expect(appliedScale()).toBe('0.9');
  });

  it('applies a pending change when the panel closes before it settles', () => {
    const { getByTestId, unmount } = renderSelector();

    fireEvent.click(getByTestId('ui-scale-increase'));
    expect(appliedScale()).toBe('');

    unmount();

    expect(appliedScale()).toBe('1.1');
    expect(localStorage.getItem('uiScale')).toBe('1.1');
  });

  it('persists a pending step when the document leaves before reflow', () => {
    const { getByTestId } = renderSelector();
    fireEvent.click(getByTestId('ui-scale-increase'));

    act(() => window.dispatchEvent(new Event('pagehide')));

    expect(localStorage.getItem('uiScale')).toBe('1.1');
    expect(appliedScale()).toBe('1.1');
  });

  it('restores a persisted scale on mount', () => {
    localStorage.setItem('uiScale', '1.25');

    const { getByText } = renderSelector();

    expect(getByText('125%')).toBeInTheDocument();
  });

  it('disables the steppers at the ends of the range', () => {
    localStorage.setItem('uiScale', '1.5');
    const { getByTestId, unmount } = renderSelector();

    expect(getByTestId('ui-scale-increase')).toBeDisabled();
    expect(getByTestId('ui-scale-decrease')).not.toBeDisabled();

    unmount();
    localStorage.setItem('uiScale', '0.5');
    const min = renderSelector();

    expect(min.getByTestId('ui-scale-decrease')).toBeDisabled();
    expect(min.getByTestId('ui-scale-increase')).not.toBeDisabled();
  });

  it('snaps to the neighbouring stop from an off-stop value', () => {
    localStorage.setItem('uiScale', '1.05');
    const { getByTestId, getByText } = renderSelector();

    expect(getByText('105%')).toBeInTheDocument();

    fireEvent.click(getByTestId('ui-scale-increase'));

    expect(getByText('110%')).toBeInTheDocument();
  });
});
