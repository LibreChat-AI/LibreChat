import React from 'react';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import ExportAndShareMenu from '../ExportAndShareMenu';

const mockOptions = { show: true, hasSharedLink: false };
const mockUseChatOptions = jest.fn();
const mockDropdown: { current?: { setIsOpen: (open: boolean) => void } } = {};

jest.mock('@ariakit/react', () => ({
  MenuButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock('@librechat/client', () => ({
  DropdownPopup: (props: { trigger: React.ReactNode; setIsOpen: (open: boolean) => void }) => {
    mockDropdown.current = props;
    return props.trigger;
  },
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
  useMediaQuery: () => false,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/Chat/useChatOptions', () => ({
  __esModule: true,
  default: (args: unknown) => {
    mockUseChatOptions(args);
    return { ...mockOptions, items: [], dialogs: null };
  },
}));

describe('ExportAndShareMenu link status', () => {
  beforeEach(() => {
    mockOptions.show = true;
    mockOptions.hasSharedLink = false;
    mockUseChatOptions.mockClear();
  });

  it('shows a blue circular indicator when the conversation has a link', () => {
    mockOptions.hasSharedLink = true;

    render(<ExportAndShareMenu isSharedButtonEnabled={true} />);

    expect(screen.getByTestId('header-shared-link-indicator')).toHaveClass(
      'rounded-full',
      'bg-status-info',
      '-right-0.5',
      '-top-0.5',
      'size-2',
    );
    expect(screen.getByRole('button')).toHaveAttribute(
      'aria-label',
      'com_ui_chat_options_link_active',
    );
  });

  it('uses the default options label when the conversation has no link', () => {
    render(<ExportAndShareMenu isSharedButtonEnabled={true} />);

    expect(screen.queryByTestId('header-shared-link-indicator')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'com_ui_chat_options');
  });

  it('tells the options hook when the menu is open so the project list can load', () => {
    render(<ExportAndShareMenu isSharedButtonEnabled={true} />);
    expect(mockUseChatOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ isMenuOpen: false }),
    );

    act(() => mockDropdown.current?.setIsOpen(true));

    expect(mockUseChatOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ isMenuOpen: true }),
    );
  });

  it('renders nothing for a conversation that has not been saved', () => {
    mockOptions.show = false;

    const { container } = render(<ExportAndShareMenu isSharedButtonEnabled={true} />);

    expect(container).toBeEmptyDOMElement();
  });
});
