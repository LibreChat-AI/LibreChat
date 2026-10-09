import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { ErrorDisplay } from '../ErrorDisplay';

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(() => ({ data: undefined })),
}));
const mockUseGetStartupConfig = jest.requireMock('~/data-provider')
  .useGetStartupConfig as jest.Mock;

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Mock the localize hook
const mockLocalize = jest.fn((key: string, options?: any) => {
  const translations: Record<string, string> = {
    com_agents_error_title: 'Something went wrong',
    com_agents_error_suggestion_generic: 'Please try refreshing the page or try again later.',
    com_agents_error_network_title: 'Connection Problem',
    com_agents_error_network_suggestion: 'Check your internet connection and try again.',
    com_agents_error_not_found_title: 'Not Found',
    com_agents_error_not_found_message: 'The requested content could not be found.',
    com_agents_error_invalid_request: 'Invalid Request',
    com_agents_error_bad_request_suggestion: 'Please check your input and try again.',
    com_agents_error_server_title: 'Server Error',
    com_agents_error_server_suggestion: 'Please try again in a few moments.',
    com_agents_error_search_title: 'Search Error',
    com_agents_error_category_title: 'Category Error',
    com_agents_error_timeout_title: 'Connection Timeout',
    com_agents_error_timeout_suggestion: 'Please check your internet connection and try again.',
    com_agents_error_rate_limit_title: 'Slow Down',
    com_agents_error_rate_limit_suggestion:
      'Too many requests were sent at once. Retrying shortly.',
    com_agents_search_no_results: `No agents found for "${options?.query}"`,
    com_agents_category_empty: `No agents found in the ${options?.category} category`,
    com_agents_error_retry: 'Try Again',
    com_agents_error_retrying: 'Retrying',
    com_agents_error_retry_countdown: `Retrying automatically in ${options?.seconds}s`,
    com_ui_refresh_page: 'Refresh page',
  };

  return translations[key] || key;
});

jest.mock('~/hooks/useLocalize', () => () => mockLocalize);

describe('ErrorDisplay', () => {
  beforeEach(() => {
    mockLocalize.mockClear();
    mockUseGetStartupConfig.mockReset();
    mockUseGetStartupConfig.mockReturnValue({ data: undefined });
  });

  describe('Backend error responses', () => {
    it('displays user-friendly message from backend response', () => {
      const error = {
        response: {
          data: {
            userMessage: 'Unable to load agents. Please try refreshing the page.',
            suggestion: 'Try refreshing the page or check your network connection',
          },
        },
      };

      render(<ErrorDisplay error={error} />);

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      expect(
        screen.getByText('Unable to load agents. Please try refreshing the page.'),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Try refreshing the page or check your network connection'),
      ).not.toBeInTheDocument();
    });

    it('handles search context with backend response', () => {
      const error = {
        response: {
          data: {
            userMessage: 'Search is temporarily unavailable. Please try again.',
            suggestion: 'Try a different search term or check your network connection',
          },
        },
      };

      render(<ErrorDisplay error={error} context={{ searchQuery: 'test query' }} />);

      expect(screen.getByText('Search Error')).toBeInTheDocument();
      expect(
        screen.getByText('Search is temporarily unavailable. Please try again.'),
      ).toBeInTheDocument();
    });
  });

  describe('Network errors', () => {
    it('displays network error message', () => {
      const error = {
        code: 'NETWORK_ERROR',
        message: 'Network Error',
      };

      render(<ErrorDisplay error={error} />);

      expect(screen.getByText('Connection Problem')).toBeInTheDocument();
      expect(screen.getByText('Check your internet connection and try again.')).toBeInTheDocument();
    });

    it('handles timeout errors', () => {
      const error = {
        code: 'ECONNABORTED',
        message: 'timeout of 5000ms exceeded',
      };

      render(<ErrorDisplay error={error} />);

      expect(mockLocalize).toHaveBeenCalledWith('com_agents_error_timeout_title');
      expect(mockLocalize).toHaveBeenCalledWith('com_agents_error_timeout_suggestion');
    });
  });

  describe('HTTP status codes', () => {
    it('handles 404 errors with search context', () => {
      const error = {
        response: {
          status: 404,
          data: {},
        },
      };

      render(<ErrorDisplay error={error} context={{ searchQuery: 'nonexistent agent' }} />);

      expect(screen.getByText('Not Found')).toBeInTheDocument();
      expect(screen.getByText('No agents found for "nonexistent agent"')).toBeInTheDocument();
    });

    it('handles 404 errors with category context', () => {
      const error = {
        response: {
          status: 404,
          data: {},
        },
      };

      render(<ErrorDisplay error={error} context={{ category: 'productivity' }} />);

      expect(screen.getByText('Not Found')).toBeInTheDocument();
      expect(screen.getByText('No agents found in the productivity category')).toBeInTheDocument();
    });

    it('handles 400 bad request errors', () => {
      const error = {
        response: {
          status: 400,
          data: {
            error: 'Search query is required',
            userMessage: 'Please enter a search term to find agents',
            suggestion: 'Enter a search term to find agents by name or description',
          },
        },
      };

      render(<ErrorDisplay error={error} />);

      expect(screen.getByText('Invalid Request')).toBeInTheDocument();
      expect(screen.getByText('Please enter a search term to find agents')).toBeInTheDocument();
      expect(
        screen.queryByText('Enter a search term to find agents by name or description'),
      ).not.toBeInTheDocument();
    });

    it('handles 500 server errors', () => {
      const error = {
        response: {
          status: 500,
          data: {},
        },
      };

      render(<ErrorDisplay error={error} />);

      expect(screen.getByText('Server Error')).toBeInTheDocument();
      expect(screen.getByText('Please try again in a few moments.')).toBeInTheDocument();
    });
  });

  describe('Retry functionality', () => {
    it('displays retry button when onRetry is provided', () => {
      const mockRetry = jest.fn();
      const error = {
        response: {
          data: {
            userMessage: 'Unable to load agents. Please try refreshing the page.',
          },
        },
      };

      render(<ErrorDisplay error={error} onRetry={mockRetry} />);

      const retryButton = screen.getByText('Try Again');
      expect(retryButton).toBeInTheDocument();

      fireEvent.click(retryButton);
      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    it('does not display retry button when onRetry is not provided', () => {
      const error = {
        response: {
          data: {
            userMessage: 'Unable to load agents. Please try refreshing the page.',
          },
        },
      };

      render(<ErrorDisplay error={error} />);

      expect(screen.queryByText('Try Again')).not.toBeInTheDocument();
    });

    it('reports progress and blocks a second click while a retry runs', () => {
      const mockRetry = jest.fn();
      const error = { code: 'ERR_NETWORK', message: 'Network Error' };

      render(<ErrorDisplay error={error} onRetry={mockRetry} isRetrying />);

      /* Busy, not gone: a `disabled` control leaves focus navigation, and a reader who
         pressed this one has to still be on it when the attempt fails. */
      const retryButton = screen.getByRole('button', { name: 'Retrying' });
      expect(retryButton).not.toBeDisabled();
      expect(retryButton).toHaveAttribute('aria-disabled', 'true');
      expect(retryButton).toHaveAttribute('aria-busy', 'true');

      fireEvent.click(retryButton);
      expect(mockRetry).not.toHaveBeenCalled();
    });
  });

  describe('Automatic recovery', () => {
    const networkError = { code: 'ERR_NETWORK', message: 'Network Error' };

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('retries a transient failure without user action', () => {
      const mockRetry = jest.fn();

      render(<ErrorDisplay error={networkError} onRetry={mockRetry} />);

      expect(screen.getByText('Retrying automatically in 2s')).toBeInTheDocument();
      expect(mockRetry).not.toHaveBeenCalled();

      act(() => {
        jest.advanceTimersByTime(2000);
      });

      expect(mockRetry).toHaveBeenCalledTimes(1);
    });
    it('uses configured retry delays for automatic recovery', () => {
      const mockRetry = jest.fn();
      mockUseGetStartupConfig.mockReturnValue({
        data: { interface: { marketplace: { retryDelaysMs: [50] } } },
      });

      render(<ErrorDisplay error={networkError} onRetry={mockRetry} />);

      expect(screen.getByText('Retrying automatically in 0s')).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(49);
      });
      expect(mockRetry).not.toHaveBeenCalled();

      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    it('leaves only manual retry when automatic delays are empty', () => {
      const mockRetry = jest.fn();
      mockUseGetStartupConfig.mockReturnValue({
        data: { interface: { marketplace: { retryDelaysMs: [] } } },
      });

      render(<ErrorDisplay error={networkError} onRetry={mockRetry} />);

      expect(screen.queryByText(/Retrying automatically/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Refresh page' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    it('uses shipped retry delays when startup config is unavailable', () => {
      const mockRetry = jest.fn();

      render(<ErrorDisplay error={networkError} onRetry={mockRetry} />);

      expect(screen.getByText('Retrying automatically in 2s')).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    /** Axios delivers failures as `Error` subclasses, which is how the
     *  marketplace queries report them: classification has to read through the
     *  instance rather than reducing it to its message. */
    it('recovers from a server failure delivered as an Axios error instance', () => {
      const mockRetry = jest.fn();
      const error = Object.assign(new Error('Request failed with status code 500'), {
        code: 'ERR_BAD_RESPONSE',
        response: { status: 500, data: {} },
      });

      render(<ErrorDisplay error={error} onRetry={mockRetry} />);

      expect(screen.getByText('Server Error')).toBeInTheDocument();
      expect(screen.getByText('Retrying automatically in 2s')).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(2000);
      });

      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    /** The marketplace query retries a 408 and a 429 twice and then hands the failure
     *  to this card, so classifying either as final would strand the recovery. */
    it('keeps recovering from a request timeout', () => {
      const mockRetry = jest.fn();
      const error = { response: { status: 408, data: {} } };

      render(<ErrorDisplay error={error} onRetry={mockRetry} />);

      expect(screen.getByText('Connection Timeout')).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(2000);
      });

      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    it('keeps recovering from a throttled request', () => {
      const mockRetry = jest.fn();
      const error = { response: { status: 429, data: {} } };

      render(<ErrorDisplay error={error} onRetry={mockRetry} />);

      expect(screen.getByText('Slow Down')).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(2000);
      });

      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    it('retries at once when the browser reconnects', () => {
      const mockRetry = jest.fn();

      render(<ErrorDisplay error={networkError} onRetry={mockRetry} />);

      act(() => {
        window.dispatchEvent(new Event('online'));
      });

      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    it('leaves answered requests alone', () => {
      const mockRetry = jest.fn();
      const error = { response: { status: 404, data: {} } };

      render(<ErrorDisplay error={error} onRetry={mockRetry} />);

      act(() => {
        window.dispatchEvent(new Event('online'));
        jest.advanceTimersByTime(120000);
      });

      expect(mockRetry).not.toHaveBeenCalled();
      expect(screen.queryByText(/Retrying automatically/)).not.toBeInTheDocument();
    });

    it('stops after the backoff is exhausted and offers a reload', () => {
      const mockRetry = jest.fn();

      render(<ErrorDisplay error={networkError} onRetry={mockRetry} />);

      for (const delay of [2000, 5000, 10000, 20000]) {
        act(() => {
          jest.advanceTimersByTime(delay);
        });
      }

      expect(mockRetry).toHaveBeenCalledTimes(4);
      expect(screen.getByRole('button', { name: 'Refresh page' })).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(120000);
      });

      expect(mockRetry).toHaveBeenCalledTimes(4);
    });
  });

  describe('Context-aware titles', () => {
    it('shows search error title for search context', () => {
      const error = { message: 'Some error' };

      render(<ErrorDisplay error={error} context={{ searchQuery: 'test' }} />);

      expect(mockLocalize).toHaveBeenCalledWith('com_agents_error_search_title');
    });

    it('shows category error title for category context', () => {
      const error = { message: 'Some error' };

      render(<ErrorDisplay error={error} context={{ category: 'productivity' }} />);

      expect(mockLocalize).toHaveBeenCalledWith('com_agents_error_category_title');
    });

    it('shows generic error title when no context', () => {
      const error = { message: 'Some error' };

      render(<ErrorDisplay error={error} />);

      expect(mockLocalize).toHaveBeenCalledWith('com_agents_error_title');
    });
  });

  describe('Fallback error handling', () => {
    it('handles unknown errors gracefully', () => {
      const error = {
        message: 'Unknown error occurred',
      };

      render(<ErrorDisplay error={error} />);

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      expect(
        screen.getByText('Please try refreshing the page or try again later.'),
      ).toBeInTheDocument();
    });

    it('handles null/undefined errors', () => {
      render(<ErrorDisplay error={{}} />);

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      expect(
        screen.getByText('Please try refreshing the page or try again later.'),
      ).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('has proper heading structure', () => {
      const error = { message: 'Test error' };

      render(<ErrorDisplay error={error} />);

      const heading = screen.getByRole('heading', { level: 3 });
      expect(heading).toHaveTextContent('Something went wrong');
    });
  });
});
