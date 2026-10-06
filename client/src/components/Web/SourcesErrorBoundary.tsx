import React, { Component, ReactNode } from 'react';
import { Button } from '@librechat/client';
import { reportBoundaryError } from '~/lib/rum/logs';
import { useLocalize } from '~/hooks';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  showDetails?: boolean;
}

interface State {
  hasError: boolean;
}

function DefaultFallback() {
  const localize = useLocalize();
  return (
    <div
      className="border-border-medium bg-surface-secondary flex flex-col items-center justify-center rounded-lg border p-4 text-center"
      role="alert"
      aria-live="polite"
    >
      {/* eslint-disable-next-line i18next/no-literal-string */}
      <div className="text-text-secondary mb-2 text-sm">Sources temporarily unavailable</div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => window.location.reload()}
        aria-label={localize('com_ui_reload_page')}
      >
        {localize('com_ui_refresh')}
      </Button>
    </div>
  );
}

class SourcesErrorBoundary extends Component<Props, State> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Sources error:', error);
    reportBoundaryError('sources', error);
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return <DefaultFallback />;
    }

    return this.props.children;
  }
}

export default SourcesErrorBoundary;
