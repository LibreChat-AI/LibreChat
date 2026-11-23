import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TConfirmEmailChange } from 'librechat-data-provider';
import VerifyEmail from '~/components/Auth/VerifyEmail';
import * as dataProvider from '~/data-provider';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  Spinner: () => null,
  ThemeSelector: () => null,
}));

jest.mock('~/data-provider', () => ({
  useVerifyEmailMutation: jest.fn(),
  useResendVerificationEmail: jest.fn(),
  useConfirmEmailChangeMutation: jest.fn(),
}));

const mockUseVerifyEmailMutation = jest.mocked(dataProvider.useVerifyEmailMutation);
const mockUseResendVerificationEmail = jest.mocked(dataProvider.useResendVerificationEmail);
const mockUseConfirmEmailChangeMutation = jest.mocked(dataProvider.useConfirmEmailChangeMutation);

const emailChangeUrl =
  '/verify?type=email-change&userId=507f1f77bcf86cd799439011&email=new%40example.com&token=raw-token';
const verifyUrl = '/verify?email=user%40example.com&token=raw-token';

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <VerifyEmail />
    </MemoryRouter>,
  );

const idleMutationState = () => ({
  context: undefined,
  data: undefined,
  error: null,
  failureCount: 0,
  failureReason: null,
  isError: false as const,
  isIdle: true as const,
  isLoading: false as const,
  isPaused: false,
  isSuccess: false as const,
  status: 'idle' as const,
  variables: undefined,
  reset: jest.fn(),
});

describe('VerifyEmail', () => {
  beforeEach(() => {
    mockUseVerifyEmailMutation.mockReturnValue({
      ...idleMutationState(),
      mutate: jest.fn(),
      mutateAsync: jest.fn(),
    });
    mockUseResendVerificationEmail.mockReturnValue({
      ...idleMutationState(),
      mutate: jest.fn(),
      mutateAsync: jest.fn(),
    });
    mockUseConfirmEmailChangeMutation.mockImplementation((options) => ({
      ...idleMutationState(),
      mutate: jest.fn((variables: TConfirmEmailChange) => {
        options?.onError?.({ response: { data: { code: 'invalid_token' } } }, variables, undefined);
      }),
      mutateAsync: jest.fn(),
    }));
  });

  it('does not show a redirect countdown after email-change verification fails', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          '/verify?type=email-change&userId=507f1f77bcf86cd799439011&email=new%40example.com&token=raw-token',
        ]}
      >
        <VerifyEmail />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm email change' }));
    expect(
      await screen.findByRole('heading', { name: 'Email change verification failed 😢' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Redirecting in/i)).not.toBeInTheDocument();
  });

  it('announces the email-change verification result in a live region', async () => {
    render(
      <MemoryRouter
        initialEntries={[
          '/verify?type=email-change&userId=507f1f77bcf86cd799439011&email=new%40example.com&token=raw-token',
        ]}
      >
        <VerifyEmail />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm email change' }));
    const heading = await screen.findByRole('heading', {
      name: 'Email change verification failed 😢',
    });
    expect(heading).toHaveAttribute('aria-live', 'polite');
    expect(heading).toHaveAttribute('aria-atomic', 'true');
  });

  it('renders the same live status heading while verification is still pending', () => {
    mockUseConfirmEmailChangeMutation.mockReturnValue({
      ...idleMutationState(),
      mutate: jest.fn(),
      mutateAsync: jest.fn(),
    });

    render(
      <MemoryRouter
        initialEntries={[
          '/verify?type=email-change&userId=507f1f77bcf86cd799439011&email=new%40example.com&token=raw-token',
        ]}
      >
        <VerifyEmail />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm email change' }));
    const heading = screen.getByRole('heading', {
      name: 'Verifying your new email address, please wait',
    });
    expect(heading).toHaveAttribute('aria-live', 'polite');
    expect(heading).toHaveAttribute('aria-atomic', 'true');
  });

  it('does not consume the verification token until the user confirms', () => {
    const mutate = jest.fn();
    mockUseVerifyEmailMutation.mockReturnValue({
      ...idleMutationState(),
      mutate,
      mutateAsync: jest.fn(),
    });

    renderAt(verifyUrl);

    expect(screen.getByRole('heading', { name: 'Verify your email address' })).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();

    const button = screen.getByRole('button', { name: 'Verify email' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ email: 'user@example.com', token: 'raw-token' });
    expect(
      screen.getByRole('heading', { name: 'Verifying your email, please wait' }),
    ).toBeInTheDocument();
  });

  it('does not confirm an email change until the user confirms', () => {
    const mutate = jest.fn();
    mockUseConfirmEmailChangeMutation.mockReturnValue({
      ...idleMutationState(),
      mutate,
      mutateAsync: jest.fn(),
    });

    renderAt(emailChangeUrl);

    expect(
      screen.getByRole('heading', { name: 'Confirm your new email address' }),
    ).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm email change' }));
    expect(mutate).toHaveBeenCalledWith({
      email: 'new@example.com',
      token: 'raw-token',
      userId: '507f1f77bcf86cd799439011',
    });
  });

  it('reports a missing token without offering a confirm button', () => {
    renderAt('/verify?email=user%40example.com');

    expect(
      screen.getByRole('heading', { name: 'Verification failed, token missing 😢' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify email' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend Email' })).toBeInTheDocument();
  });
});
