import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import ChangeEmail from '../ChangeEmail';

const mockShowToast = jest.fn();
const mockMutate = jest.fn();
let mockIsLoading = false;

jest.mock('@librechat/client', () => {
  const actual = jest.requireActual('@librechat/client');
  return {
    ...actual,
    useToastContext: () => ({ showToast: mockShowToast }),
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { email: 'old@example.com' } }),
}));

jest.mock('~/data-provider', () => ({
  useRequestEmailChangeMutation: () => ({ mutate: mockMutate, isLoading: mockIsLoading }),
}));

describe('ChangeEmail', () => {
  beforeEach(() => {
    mockIsLoading = false;
  });

  async function openDialog() {
    const user = userEvent.setup();
    const view = render(<ChangeEmail />);
    await user.click(screen.getByRole('button', { name: 'com_ui_email_change_title' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    return { user, view };
  }

  it('keeps the cancel control usable while the request is pending', async () => {
    const { view } = await openDialog();

    mockIsLoading = true;
    view.rerender(<ChangeEmail />);

    expect(screen.getByRole('button', { name: 'com_ui_cancel' })).toBeEnabled();
  });

  it('still dismisses on Escape while the request is pending', async () => {
    const { user, view } = await openDialog();

    mockIsLoading = true;
    view.rerender(<ChangeEmail />);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
