import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import ChannelsDialog from '../ChannelsDialog';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

function renderDialog(props: Partial<React.ComponentProps<typeof ChannelsDialog>> = {}) {
  const onSelect = jest.fn();
  const onOpenChange = jest.fn();
  render(<ChannelsDialog open onOpenChange={onOpenChange} onSelect={onSelect} {...props} />);
  return { onSelect, onOpenChange };
}

describe('ChannelsDialog', () => {
  it('lists Slack as the available channel and names the dialog', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'com_ui_channels_title' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'com_ui_channels_title' })).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /com_ui_channels_slack/ })).toBeVisible();
  });

  it('hands the chosen channel to the caller', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderDialog();
    await user.click(screen.getByRole('button', { name: /com_ui_channels_slack/ }));
    expect(onSelect).toHaveBeenCalledWith('slack');
  });

  it('filters by search and says when nothing matches', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText('com_ui_channels_catalog_search'), 'zzz');
    expect(screen.queryByRole('button', { name: /com_ui_channels_slack/ })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_channels_catalog_empty');
  });

  it('renders nothing while closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
