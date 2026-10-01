import { render, screen } from '@testing-library/react';
import MessageRow from '../MessageRow';

jest.mock('../MessageTimestamp', () => ({
  __esModule: true,
  default: ({ className }: { className?: string }) => (
    <span data-testid="message-timestamp" className={className} />
  ),
}));

const MESSAGE_BODY = 'Message body';

const renderRow = ({
  isCreatedByUser,
  hasParallelContent = false,
  fullWidth = false,
  isEditing = false,
  systemLabel,
}: {
  isCreatedByUser: boolean;
  hasParallelContent?: boolean;
  fullWidth?: boolean;
  isEditing?: boolean;
  systemLabel?: string;
}) =>
  render(
    <MessageRow
      id="message-1"
      label={isCreatedByUser ? 'You' : 'Assistant'}
      hoverLabel={isCreatedByUser ? undefined : 'gpt-5.6'}
      icon={<span data-testid="message-icon" />}
      footer={<div data-testid="message-actions" />}
      ariaLabel={isCreatedByUser ? 'User message' : 'Assistant message'}
      headerPrefix="Message from "
      isCreatedByUser={isCreatedByUser}
      hasParallelContent={hasParallelContent}
      fullWidth={fullWidth}
      isEditing={isEditing}
      systemLabel={systemLabel}
    >
      <p>{MESSAGE_BODY}</p>
    </MessageRow>,
  );

describe('MessageRow', () => {
  it('renders a system row on the user side as an outlined bubble under a visible heading', () => {
    renderRow({ isCreatedByUser: true, systemLabel: 'System' });

    const row = screen.getByLabelText('User message');
    const messageSurface = screen.getByText(MESSAGE_BODY).parentElement;
    const heading = screen.getByRole('heading', { name: 'System' });

    expect(row).toHaveClass('justify-end');
    expect(row.querySelector('.user-turn')).toHaveClass('items-end');
    expect(messageSurface).toHaveClass('border', 'border-border-medium', 'rounded-theme-surface');
    expect(messageSurface).not.toHaveClass('bg-surface-tertiary');
    expect(heading).not.toHaveClass('sr-only');
    expect(screen.queryByText('You')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-actions')).toBeInTheDocument();
  });

  it('renders user content as a right-aligned semantic surface without a visible avatar', () => {
    renderRow({ isCreatedByUser: true });

    const row = screen.getByLabelText('User message');
    const userTurn = row.querySelector('.user-turn');
    const messageSurface = screen.getByText(MESSAGE_BODY).parentElement;

    expect(row).toHaveAttribute('role', 'group');
    expect(row).toHaveClass('justify-end');
    expect(userTurn).toHaveClass('items-end');
    expect(messageSurface).toHaveClass('bg-surface-tertiary', 'rounded-theme-surface');
    expect(screen.queryByTestId('message-icon')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { hidden: true })).toHaveClass('sr-only');
  });

  it('keeps assistant identity visible beside an open reading column', () => {
    renderRow({ isCreatedByUser: false });

    const row = screen.getByLabelText('Assistant message');

    expect(row.querySelector('.agent-turn')).toHaveClass('flex-1');
    expect(screen.getByTestId('message-icon')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Assistant/ })).toBeVisible();
  });

  it('carries the assistant avatar inside the heading without naming it', () => {
    renderRow({ isCreatedByUser: false });

    const avatar = screen.getByTestId('message-icon').parentElement;

    /** The accessible name resolves only when `aria-hidden` excludes the avatar. */
    expect(
      screen.getByRole('heading', { name: 'Message from Assistant Model: gpt-5.6' }),
    ).toContainElement(screen.getByTestId('message-icon'));
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
    expect(avatar).toHaveClass('size-6');
    expect(avatar).not.toHaveClass('md:absolute', 'md:left-0');
  });

  it('keeps the icon and provider name on the message content edge', () => {
    renderRow({ isCreatedByUser: false });

    const row = screen.getByLabelText('Assistant message');
    const agentTurn = row.querySelector('.agent-turn');

    expect(agentTurn).not.toHaveClass('md:pl-9', 'pl-9');
    expect(row).not.toHaveClass('gap-3');
    expect(row.children).toHaveLength(1);
    expect(screen.getAllByTestId('message-icon')).toHaveLength(1);
  });

  it('puts icon, name, and datetime on one bar across the message column', () => {
    renderRow({ isCreatedByUser: false });

    const heading = screen.getByRole('heading', { name: 'Message from Assistant Model: gpt-5.6' });

    expect(heading).toHaveClass('w-full', 'gap-2');
    expect(screen.getByTestId('message-timestamp')).toHaveClass('ml-auto');
  });

  it('keeps the model name ready to replace the provider on hover', () => {
    renderRow({ isCreatedByUser: false });

    expect(screen.getByText('Assistant')).toBeVisible();
    expect(screen.getByText('gpt-5.6')).toHaveAttribute('aria-hidden', 'true');
  });

  /* The crossfade is pointer-only, so the header bar has to name the model in
     the heading itself rather than leave it behind a hover. */
  it('names the model in the heading for assistive technology', () => {
    renderRow({ isCreatedByUser: false });

    expect(
      screen.getByRole('heading', { name: 'Message from Assistant Model: gpt-5.6' }),
    ).toBeVisible();
  });

  it('preserves the assistant turn marker for parallel content', () => {
    renderRow({ isCreatedByUser: false, hasParallelContent: true });

    const row = screen.getByLabelText('Assistant message');

    expect(row.querySelector('.agent-turn')).toHaveClass('w-full');
    expect(screen.queryByTestId('message-icon')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('expands an edited user message without nesting the editor in a bubble', () => {
    renderRow({ isCreatedByUser: true, isEditing: true });

    const row = screen.getByLabelText('User message');
    const messageSurface = screen.getByTestId('message-body');

    expect(row.querySelector('.user-turn')).toHaveClass('w-full');
    expect(messageSurface).toHaveClass('w-full');
    expect(messageSurface).not.toHaveClass('bg-surface-tertiary');
  });

  it('expands an edited assistant message to full width', () => {
    renderRow({ isCreatedByUser: false, isEditing: true });

    const row = screen.getByLabelText('Assistant message');
    const messageSurface = screen.getByTestId('message-body');

    expect(row.querySelector('.agent-turn')).toHaveClass('w-full');
    expect(row.querySelector('.agent-turn')).not.toHaveClass('md:pl-9');
    expect(messageSurface).toHaveClass('w-full');
  });

  it('matches the chat form reading width', () => {
    renderRow({ isCreatedByUser: false });

    expect(screen.getByLabelText('Assistant message')).toHaveClass(
      'sm:px-2',
      'md:max-w-3xl',
      'xl:max-w-4xl',
    );
  });

  it('allows the maximized preference to use the full conversation width', () => {
    renderRow({ isCreatedByUser: false, fullWidth: true });

    expect(screen.getByLabelText('Assistant message')).toHaveClass('max-w-full');
  });
});
