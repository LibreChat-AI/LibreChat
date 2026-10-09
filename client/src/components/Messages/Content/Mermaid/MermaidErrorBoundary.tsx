import React from 'react';
import { reportBoundaryError } from '~/lib/rum/logs';

interface MermaidErrorBoundaryProps {
  children: React.ReactNode;
  code: string;
}

interface MermaidErrorBoundaryState {
  hasError: boolean;
}

class MermaidErrorBoundary extends React.Component<
  MermaidErrorBoundaryProps,
  MermaidErrorBoundaryState
> {
  constructor(props: MermaidErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): MermaidErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Mermaid rendering error:', error, errorInfo);
    reportBoundaryError('mermaid', error);
  }

  componentDidUpdate(prevProps: MermaidErrorBoundaryProps) {
    if (prevProps.code !== this.props.code && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="border-border-light w-full overflow-hidden rounded-md border">
          <div className="bg-surface-secondary text-text-secondary rounded-t-md px-4 py-2 font-sans text-xs">
            {'mermaid'}
          </div>
          <pre className="bg-surface-primary-alt text-text-secondary overflow-auto rounded-b-md p-4 font-mono text-xs whitespace-pre-wrap">
            {this.props.code}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}

export default MermaidErrorBoundary;
