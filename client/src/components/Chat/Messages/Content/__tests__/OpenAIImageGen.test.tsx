import React from 'react';
import { render, screen } from '@testing-library/react';
import OpenAIImageGen from '../Parts/OpenAIImageGen/OpenAIImageGen';

jest.mock('~/utils', () => ({
  scaleImage: () => ({ width: '512px', height: '512px' }),
  cn: (...classes: (string | boolean | undefined | null)[]) =>
    classes
      .flat(Infinity)
      .filter((c): c is string => typeof c === 'string' && c.length > 0)
      .join(' '),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useProgress: (initialProgress: number) => (initialProgress >= 1 ? 1 : initialProgress),
}));

jest.mock('~/components/Chat/Messages/Content/Image', () => ({
  __esModule: true,
  default: ({ altText, imagePath }: { altText: string; imagePath: string }) => (
    <div data-testid="image-component" data-alt={altText} data-src={imagePath} />
  ),
}));

jest.mock('@librechat/client', () => ({
  PixelCard: ({ progress }: { progress: number }) => (
    <div data-testid="pixel-card" data-progress={progress} />
  ),
}));

jest.mock('../ToolOutput', () => ({
  ToolIcon: ({ type, isAnimating }: { type: string; isAnimating?: boolean }) => (
    <span data-testid="tool-icon" data-type={type} data-animating={isAnimating} />
  ),
  isError: (output: string) => typeof output === 'string' && output.toLowerCase().includes('error'),
}));

jest.mock('../Parts/OpenAIImageGen/ProgressText', () => ({
  __esModule: true,
  default: ({
    progress,
    error,
    cancelled,
  }: {
    progress: number;
    error: boolean;
    cancelled?: boolean;
  }) => (
    <div
      data-testid="progress-text"
      data-progress={progress}
      data-error={String(error)}
      data-cancelled={String(cancelled === true)}
    />
  ),
}));

describe('OpenAIImageGen', () => {
  const defaultProps = {
    initialProgress: 0.1,
    isSubmitting: true,
    toolName: 'image_gen_oai',
    args: '{"prompt":"a cat","quality":"high","size":"1024x1024"}',
    output: null as string | null,
    attachments: undefined,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('image visibility', () => {
    it('hides Image during generation when no filepath exists', () => {
      render(<OpenAIImageGen {...defaultProps} initialProgress={0.5} />);
      expect(screen.queryByTestId('image-component')).not.toBeInTheDocument();
    });

    it('shows Image when filepath is available', () => {
      render(
        <OpenAIImageGen
          {...defaultProps}
          initialProgress={1}
          isSubmitting={false}
          attachments={[
            {
              filename: 'cat.png',
              filepath: '/images/cat.png',
              conversationId: 'conv1',
            } as never,
          ]}
        />,
      );
      expect(screen.getByTestId('image-component')).toBeInTheDocument();
    });
  });

  describe('PixelCard visibility', () => {
    it('shows PixelCard when progress < 1', () => {
      render(<OpenAIImageGen {...defaultProps} initialProgress={0.5} />);
      expect(screen.getByTestId('pixel-card')).toBeInTheDocument();
    });

    it('hides PixelCard when progress >= 1', () => {
      render(<OpenAIImageGen {...defaultProps} initialProgress={1} isSubmitting={false} />);
      expect(screen.queryByTestId('pixel-card')).not.toBeInTheDocument();
    });
  });

  describe('ToolIcon', () => {
    it('renders ToolIcon with type="image_gen"', () => {
      render(<OpenAIImageGen {...defaultProps} />);
      const icon = screen.getByTestId('tool-icon');
      expect(icon).toHaveAttribute('data-type', 'image_gen');
    });

    it('sets isAnimating when in progress', () => {
      render(<OpenAIImageGen {...defaultProps} initialProgress={0.5} />);
      const icon = screen.getByTestId('tool-icon');
      expect(icon).toHaveAttribute('data-animating', 'true');
    });

    it('sets isAnimating=false when complete', () => {
      render(<OpenAIImageGen {...defaultProps} initialProgress={1} isSubmitting={false} />);
      const icon = screen.getByTestId('tool-icon');
      expect(icon).toHaveAttribute('data-animating', 'false');
    });
  });

  describe('args parsing', () => {
    it('parses quality from args', () => {
      render(<OpenAIImageGen {...defaultProps} />);
      expect(screen.getByTestId('progress-text')).toBeInTheDocument();
    });

    it('handles invalid JSON args gracefully', () => {
      render(<OpenAIImageGen {...defaultProps} args="invalid json" />);
      expect(screen.getByTestId('progress-text')).toBeInTheDocument();
    });

    it('handles object args', () => {
      render(
        <OpenAIImageGen
          {...defaultProps}
          args={{ prompt: 'a dog', quality: 'low', size: '512x512' }}
        />,
      );
      expect(screen.getByTestId('progress-text')).toBeInTheDocument();
    });
  });

  describe('cancellation', () => {
    it('shows error state when output contains error', () => {
      render(
        <OpenAIImageGen
          {...defaultProps}
          output="Error processing tool call"
          isSubmitting={false}
          initialProgress={0.5}
        />,
      );
      const progressText = screen.getByTestId('progress-text');
      expect(progressText).toHaveAttribute('data-error', 'true');
    });

    it('shows cancelled state when not submitting and incomplete', () => {
      render(<OpenAIImageGen {...defaultProps} isSubmitting={false} initialProgress={0.5} />);
      const progressText = screen.getByTestId('progress-text');
      expect(progressText).toHaveAttribute('data-cancelled', 'true');
      expect(progressText).toHaveAttribute('data-error', 'false');
    });

    it('reports a run-step cancellation as cancelled, not failed', () => {
      render(<OpenAIImageGen {...defaultProps} isSubmitting={true} runStepStatus="cancelled" />);
      const progressText = screen.getByTestId('progress-text');
      expect(progressText).toHaveAttribute('data-cancelled', 'true');
      expect(progressText).toHaveAttribute('data-error', 'false');
    });

    it('reports a run-step failure as an error even when the output is benign', () => {
      render(<OpenAIImageGen {...defaultProps} isSubmitting={true} runStepStatus="failed" />);
      const progressText = screen.getByTestId('progress-text');
      expect(progressText).toHaveAttribute('data-error', 'true');
      expect(progressText).toHaveAttribute('data-cancelled', 'false');
    });

    it('lets an explicit cancellation outrank an error-formatted output', () => {
      render(
        <OpenAIImageGen
          {...defaultProps}
          output="Error processing tool call"
          isSubmitting={true}
          runStepStatus="cancelled"
        />,
      );
      const progressText = screen.getByTestId('progress-text');
      expect(progressText).toHaveAttribute('data-cancelled', 'true');
      expect(progressText).toHaveAttribute('data-error', 'false');
    });

    it('keeps failure precedence when the legacy inference folds an error into cancellation', () => {
      render(
        <OpenAIImageGen
          {...defaultProps}
          output="Error processing tool call"
          isSubmitting={false}
          initialProgress={0.5}
        />,
      );
      const progressText = screen.getByTestId('progress-text');
      expect(progressText).toHaveAttribute('data-error', 'true');
    });
  });
});
