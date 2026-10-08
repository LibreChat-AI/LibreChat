import { render, screen } from '@testing-library/react';
import ConvoLink from '../ConvoLink';

const localize = (key: string, options?: Record<string, unknown>) =>
  options?.title != null ? `${key}:${String(options.title)}` : key;

const renderLink = (title: string | null) =>
  render(
    <ConvoLink
      isActiveConvo={false}
      isPopoverActive={false}
      isHovered={false}
      isSharedBadgeVisible={false}
      isUnseen={false}
      title={title}
      onRename={jest.fn()}
      isSmallScreen={false}
      localize={localize as never}
    >
      <span />
    </ConvoLink>,
  );

describe('ConvoLink title', () => {
  beforeAll(() => {
    window.matchMedia ??= ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })) as unknown as typeof window.matchMedia;
    window.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
  });

  it('shows the stored New Chat placeholder in the interface language', () => {
    renderLink('New Chat');

    expect(screen.getByText('com_ui_new_chat')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'com_ui_conversation_label:com_ui_new_chat',
    );
  });

  it('lets a title take its own direction while aligning to the row', () => {
    renderLink('MCP & Skill');

    const viewport = screen.getByText('MCP & Skill').parentElement;
    expect(viewport).toHaveAttribute('dir', 'auto');
    expect(screen.getByRole('button')).toHaveClass('text-left', 'rtl:text-right');
    expect(viewport?.className).not.toMatch(/text-align|text-start/);
  });
});
