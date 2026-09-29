import { Component, ErrorInfo, ReactNode, createRef } from 'react';
import { JSX } from 'react/jsx-runtime';
import { RefreshCw } from 'lucide-react';
import { useLocalize } from '~/hooks';
import { Button } from '../Button';
import { logger } from '~/utils';

/**
 * Error boundary specifically for DataTable component.
 * Catches JavaScript errors in the table rendering and provides a fallback UI.
 * Handles errors from virtualizer, cell renderers, fetch operations, and child components.
 */
interface DataTableErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

interface DataTableErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error) => void;
  onReset?: () => void;
}
interface DataTableErrorBoundaryInnerProps extends DataTableErrorBoundaryProps {
  localize: ReturnType<typeof useLocalize>;
}

class DataTableErrorBoundaryInner extends Component<
  DataTableErrorBoundaryInnerProps,
  DataTableErrorBoundaryState
> {
  private errorCardRef = createRef<HTMLDivElement>();

  constructor(props: DataTableErrorBoundaryInnerProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): DataTableErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error('DataTable Error Boundary caught an error:', error, errorInfo);
    this.props.onError?.(error);
  }

  componentDidUpdate(
    _prevProps: DataTableErrorBoundaryInnerProps,
    prevState: DataTableErrorBoundaryState,
  ) {
    if (!prevState.hasError && this.state.hasError && this.errorCardRef.current) {
      this.errorCardRef.current.focus();
    }
  }

  /**
   * Reset the error state and attempt to re-render the children.
   * This can be used to retry after a table error (e.g., network retry).
   */
  private handleReset = () => {
    this.setState({ hasError: false, error: undefined });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center p-8">
          <div
            ref={this.errorCardRef}
            role="alert"
            aria-live="assertive"
            aria-labelledby="datatable-error-title"
            aria-describedby="datatable-error-desc"
            tabIndex={-1}
            className="border-border-light bg-surface-primary-alt before:bg-surface-destructive/80 focus:ring-focus-control relative w-full max-w-md overflow-hidden rounded-lg border p-6 shadow-xs outline-hidden before:absolute before:top-0 before:left-0 before:h-full before:w-1 focus:ring-2 focus:ring-offset-2"
          >
            <div className="flex items-center gap-2">
              <RefreshCw className="text-surface-destructive h-4 w-4" />
              <h3 id="datatable-error-title" className="text-text-primary text-sm font-medium">
                {this.props.localize('com_ui_table_error')}
              </h3>
            </div>
            <p id="datatable-error-desc" className="text-text-secondary mt-2 text-sm">
              {this.props.localize('com_ui_table_error_description')}
            </p>
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={this.handleReset}
                className="hover:bg-surface-hover dark:hover:bg-surface-active flex items-center gap-2 px-3 py-1.5 text-sm"
                aria-label="Retry loading table"
              >
                <RefreshCw className="h-3 w-3" />
                {this.props.localize('com_ui_retry')}
              </Button>
            </div>
          </div>

          {import.meta.env.MODE === 'development' && this.state.error && (
            <details className="bg-surface-secondary mt-4 max-w-md rounded-md p-3 text-xs">
              <summary className="text-text-primary cursor-pointer font-medium">
                {this.props.localize('com_ui_error_details')}
              </summary>
              <pre className="text-text-secondary mt-2 whitespace-pre-wrap">
                {this.state.error.message}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export function DataTableErrorBoundary(props: DataTableErrorBoundaryProps): JSX.Element {
  const localize = useLocalize();
  return <DataTableErrorBoundaryInner {...props} localize={localize} />;
}

export default DataTableErrorBoundary;
