import 'test/matchMedia.mock';
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { clickDropdown, flushDropdownEffects } from 'test/dropdown';
import '@testing-library/jest-dom/extend-expect';
import { RecoilRoot } from 'recoil';
import { LangSelector } from './Selectors';
import store from '~/store';

describe('LangSelector', () => {
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
        <LangSelector langcode="en-US" onChange={mockOnChange} />
      </RecoilRoot>,
    );

    expect(getByText('Language')).toBeInTheDocument();
    const dropdownButton = getByRole('combobox');
    expect(dropdownButton).toHaveTextContent('English');

    await flushDropdownEffects();
  });

  it('calls onChange when the select value changes', async () => {
    global.ResizeObserver = class MockedResizeObserver {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    };
    const { getByRole, getByTestId } = render(
      <RecoilRoot>
        <LangSelector langcode="en-US" onChange={mockOnChange} />
      </RecoilRoot>,
    );

    expect(getByRole('combobox')).toHaveTextContent('English');

    const dropdownButton = getByTestId('dropdown-menu');

    await clickDropdown(dropdownButton);

    const italianOption = getByRole('option', { name: 'Italiano' });
    await clickDropdown(italianOption);

    await waitFor(() => {
      expect(mockOnChange).toHaveBeenCalledWith('it-IT');
    });
  });

  it('shows a loading indicator while language resources load', () => {
    global.ResizeObserver = class MockedResizeObserver {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    };
    const { getByRole } = render(
      <RecoilRoot initializeState={({ set }) => set(store.languageLoading, true)}>
        <LangSelector langcode="en-US" onChange={mockOnChange} />
      </RecoilRoot>,
    );

    expect(getByRole('status', { name: 'Loading...' })).toBeInTheDocument();
  });
});
