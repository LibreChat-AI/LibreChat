import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import ImageGen from '../Parts/OpenAIImageGen/OpenAIImageGen';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_ui_generating_image: 'Generating image...',
      com_ui_image_created: 'Image created',
      com_ui_image_gen_failed: 'Image generation failed',
      com_ui_getting_started: 'Getting started',
      com_ui_creating_image: 'Creating image',
      com_ui_adding_details: 'Adding details',
      com_ui_final_touch: 'Final touch',
      com_ui_error: 'Error',
    };
    return translations[key] || key;
  },
}));

jest.mock('@librechat/chat/react', () => ({
  ...jest.requireActual('@librechat/chat/react'),
  useProgress: (initialProgress: number) => (initialProgress >= 1 ? 1 : initialProgress),
}));

const getProgressLabel = (progress: number) =>
  progress >= 1 ? 'Image created' : 'Generating image...';

jest.mock('../Parts/OpenAIImageGen/ProgressText', () => ({
  __esModule: true,
  default: ({
    toolName,
    progress,
    error,
    onClick,
    hasInput,
    isExpanded,
  }: {
    toolName: string;
    progress: number;
    error?: boolean;
    onClick?: () => void;
    hasInput?: boolean;
    isExpanded?: boolean;
  }) => (
    <button
      data-testid="progress-text"
      data-tool-name={toolName}
      data-progress={progress}
      data-error={error}
      data-has-input={hasInput}
      data-is-expanded={isExpanded}
      onClick={onClick}
      type="button"
    >
      {error ? 'Error' : getProgressLabel(progress)}
    </button>
  ),
}));

jest.mock('@librechat/client', () => ({
  PixelCard: (props: Record<string, unknown>) => (
    <div data-testid="pixel-card" data-progress={props.progress} />
  ),
}));

jest.mock('~/components/Chat/Messages/Content/Image', () => ({
  __esModule: true,
  default: () => <div data-testid="image" />,
}));

jest.mock('../ToolOutput', () => ({
  ToolIcon: ({ type, isAnimating }: { type: string; isAnimating?: boolean }) => (
    <span data-testid="tool-icon" data-type={type} data-animating={isAnimating} />
  ),
  isError: (output: string) => typeof output === 'string' && output.toLowerCase().includes('error'),
}));

jest.mock('~/utils', () => ({
  scaleImage: () => ({ width: '512px', height: '512px' }),
  logger: { error: jest.fn(), debug: jest.fn() },
  cn: (...classes: (string | boolean | undefined)[]) => classes.filter(Boolean).join(' '),
}));

const defaultProps = {
  initialProgress: 1,
  isSubmitting: false,
  toolName: 'image_gen_oai',
  args: '{}',
  output: '',
};

const renderImageGen = (props: Partial<typeof defaultProps> = {}) =>
  render(
    <RecoilRoot>
      <ImageGen {...defaultProps} {...props} />
    </RecoilRoot>,
  );

describe('ImageGen - LGCY-01: Modern visual patterns', () => {
  it('renders ToolIcon with type="image_gen" for agent-style tools', () => {
    renderImageGen({
      toolName: 'image_gen_oai',
      isSubmitting: false,
      initialProgress: 1,
      args: '{}',
      output: '',
    });

    const icon = screen.queryByTestId('tool-icon');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('data-type', 'image_gen');
  });

  it('renders ToolIcon with type="image_gen" for legacy tools', () => {
    renderImageGen({
      initialProgress: 1,
      args: '{"prompt":"test"}',
    });

    const icon = screen.queryByTestId('tool-icon');
    expect(icon).toBeInTheDocument();
  });

  it('does not render ProgressCircle', () => {
    renderImageGen();

    expect(screen.queryByTestId('progress-circle')).not.toBeInTheDocument();
    expect(document.querySelector('.progress-circle')).toBeNull();
  });

  it('renders PixelCard during agent-style image generation', () => {
    renderImageGen({
      isSubmitting: true,
      initialProgress: 0.5,
      toolName: 'image_gen_oai',
      args: '{"size":"1024x1024"}',
    });

    expect(screen.getByTestId('pixel-card')).toBeInTheDocument();
  });
});

describe('ImageGen - LGCY-01: Legacy and agent-style unification', () => {
  it('accepts legacy props (initialProgress + args only)', () => {
    const { container } = render(
      <RecoilRoot>
        <ImageGen
          initialProgress={1}
          isSubmitting={false}
          toolName=""
          args='{"prompt":"a cat"}'
          output=""
        />
      </RecoilRoot>,
    );

    expect(container).toBeTruthy();
  });

  it('accepts agent-style props (full set)', () => {
    const { container } = renderImageGen({
      initialProgress: 1,
      isSubmitting: false,
      toolName: 'image_gen_oai',
      args: '{"prompt":"a cat","size":"1024x1024"}',
      output: 'https://example.com/image.png',
    });

    expect(container).toBeTruthy();
  });

  it('handles history reload state (initialProgress=1, no isSubmitting)', () => {
    renderImageGen({
      initialProgress: 1,
      isSubmitting: false,
    });

    const progressText = screen.getByTestId('progress-text');
    expect(progressText).toHaveTextContent('Image created');
  });
});

describe('ImageGen - LGCY-03: Localization', () => {
  it('does not contain hardcoded "Creating Image" text', () => {
    const { container } = renderImageGen({
      isSubmitting: true,
      initialProgress: 0.5,
      args: '{}',
    });

    expect(container.textContent).not.toContain('Creating Image');
  });

  it('does not contain hardcoded "Finished." text', () => {
    const { container } = renderImageGen({
      initialProgress: 1,
      isSubmitting: false,
    });

    expect(container.textContent).not.toContain('Finished.');
  });
});

describe('ImageGen - A11Y-04: screen reader status announcements', () => {
  it('includes sr-only aria-live region for status announcements', () => {
    renderImageGen({
      initialProgress: 1,
      isSubmitting: false,
      args: '{"prompt":"test"}',
      output: '',
    });

    const liveRegion = document.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion!.className).toContain('sr-only');
  });
});
