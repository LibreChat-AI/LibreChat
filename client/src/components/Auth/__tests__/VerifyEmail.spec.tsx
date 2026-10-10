import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import type { TConfirmEmailChange } from 'librechat-data-provider';
import VerifyEmail from '~/components/Auth/VerifyEmail';
import * as dataProvider from '~/data-provider';

jest.mock('@librechat/client', () => ({
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

    const heading = screen.getByRole('heading', {
      name: 'Verifying your new email address, please wait',
    });
    expect(heading).toHaveAttribute('aria-live', 'polite');
    expect(heading).toHaveAttribute('aria-atomic', 'true');
  });
});
