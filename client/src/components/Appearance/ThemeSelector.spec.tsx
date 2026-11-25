// ThemeSelector.spec.tsx
import 'test/matchMedia.mock';
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { clickDropdown, flushDropdownEffects } from 'test/dropdown';
import '@testing-library/jest-dom/extend-expect';
import { RecoilRoot } from 'recoil';
import { ThemeSelector } from './Selectors';

describe('ThemeSelector', () => {
  let mockOnChange;

  beforeEach(() => {
    mockOnChange = jest.fn();
  });

  it('renders correctly', async () => {
    global.ResizeObserver = class MockedResizeObserver {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    };
    const { getByText, getByRole } = render(
      <RecoilRoot>
        <ThemeSelector theme="system" onChange={mockOnChange} />
      </RecoilRoot>,
    );

    expect(getByText('Theme')).toBeInTheDocument();
    const dropdownButton = getByRole('combobox');
    expect(dropdownButton).toHaveTextContent('System');

    await flushDropdownEffects();
  });

  it('calls onChange when the select value changes', async () => {
    global.ResizeObserver = class MockedResizeObserver {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    };
    const { getByText, getByTestId } = render(
      <RecoilRoot>
        <ThemeSelector theme="system" onChange={mockOnChange} />
      </RecoilRoot>,
    );

    expect(getByText('Theme')).toBeInTheDocument();

    const dropdownButton = getByTestId('theme-selector');

    await clickDropdown(dropdownButton);

    const darkOption = getByText('Dark');
    await clickDropdown(darkOption);

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalledWith('dark');
    });
  });

  it('offers both high contrast options and reports the selected one', async () => {
    global.ResizeObserver = class MockedResizeObserver {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    };
    const { getByText, getByTestId } = render(
      <RecoilRoot>
        <ThemeSelector theme="system" onChange={mockOnChange} />
      </RecoilRoot>,
    );

    fireEvent.click(getByTestId('theme-selector'));

    expect(getByText('High contrast light')).toBeInTheDocument();
    fireEvent.click(getByText('High contrast dark'));

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalledWith('high-contrast-dark');
    });
  });

  it('shows the active high contrast mode as the current value', () => {
    global.ResizeObserver = class MockedResizeObserver {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    };
    const { getByRole } = render(
      <RecoilRoot>
        <ThemeSelector theme="high-contrast-light" onChange={mockOnChange} />
      </RecoilRoot>,
    );

    expect(getByRole('combobox')).toHaveTextContent('High contrast light');
  });
});
