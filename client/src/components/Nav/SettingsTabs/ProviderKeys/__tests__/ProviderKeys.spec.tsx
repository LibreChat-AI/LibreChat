import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor } from 'test/layout-test-utils';
import ProviderKeys from '../ProviderKeys';

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetEndpointsQuery: () => ({ data: {} }),
}));

jest.mock('../useProviderKeys', () => () => []);

describe('ProviderKeys', () => {
  it('keeps help hidden until its trigger receives focus', async () => {
    render(<ProviderKeys />);

    await userEvent.click(screen.getByRole('button', { name: 'Provider API keys' }));

    const dialog = screen.getByRole('dialog');
    const helpText = 'Manage API keys for endpoints configured to use a user-provided key.';
    const helpTrigger = screen.getByLabelText(helpText);

    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.queryByText(helpText)).not.toBeInTheDocument();

    fireEvent.focus(helpTrigger);
    expect(await screen.findByText(helpText)).toBeVisible();
  });
});
