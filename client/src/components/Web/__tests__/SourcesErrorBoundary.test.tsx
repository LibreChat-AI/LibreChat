/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import SourcesErrorBoundary from '../SourcesErrorBoundary';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    if (key === 'com_sources_temporarily_unavailable') {
      return 'Sources temporairement indisponibles';
    }
    if (key === 'com_ui_reload_page') {
      return 'Reload the page';
    }
    return key;
  },
}));

// Component that throws an error for testing
const ThrowError = ({ shouldThrow }: { shouldThrow: boolean }) => {
  if (shouldThrow) {
    throw new Error('Test error');
  }
  return <div data-testid="normal-component">{'Normal component'}</div>;
};

describe('SourcesErrorBoundary - NEW COMPONENT test', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Suppress error console logs during tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should render children when there is no error', () => {
    render(
      <SourcesErrorBoundary>
        <ThrowError shouldThrow={false} />
      </SourcesErrorBoundary>,
    );

    expect(screen.getByTestId('normal-component')).toBeInTheDocument();
  });

  it('should render default error UI when error occurs', () => {
    render(
      <SourcesErrorBoundary>
        <ThrowError shouldThrow={true} />
      </SourcesErrorBoundary>,
    );

    expect(screen.getByText('Sources temporairement indisponibles')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeInTheDocument();
  });

  it('should reload page when refresh button is clicked', () => {
    const reloadSpy = jest.spyOn(window.location, 'reload').mockImplementation(() => {});

    render(
      <SourcesErrorBoundary>
        <ThrowError shouldThrow={true} />
      </SourcesErrorBoundary>,
    );

    const refreshButton = screen.getByRole('button', { name: 'Reload the page' });
    fireEvent.click(refreshButton);

    expect(reloadSpy).toHaveBeenCalled();
  });
});
