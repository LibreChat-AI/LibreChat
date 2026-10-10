import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { MyFilesModal } from './MyFilesModal';

jest.mock('~/data-provider', () => ({
  useGetFiles: () => ({ data: [] }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('./Table', () => ({
  columns: [],
  DataTable: () => <div data-testid="files-table" />,
}));

function Harness({ trigger }: { trigger: HTMLElement }) {
  const [open, setOpen] = useState(true);
  return <MyFilesModal open={open} onOpenChange={setOpen} triggerRef={{ current: trigger }} />;
}

describe('MyFilesModal focus restoration', () => {
  it('returns focus to the shortcut invoker instead of the account button', async () => {
    const user = userEvent.setup();
    const invoker = document.createElement('button');
    const inertSidebar = document.createElement('div');
    const accountButton = document.createElement('button');
    inertSidebar.setAttribute('inert', '');
    inertSidebar.append(accountButton);
    document.body.append(invoker, inertSidebar);
    invoker.focus();

    render(<Harness trigger={accountButton} />);
    await user.click(await screen.findByRole('button', { name: 'Close' }));

    await waitFor(() => expect(invoker).toHaveFocus());
  });

  it('falls back to the account button when the dialog opens from its menu', async () => {
    const user = userEvent.setup();
    const menu = document.createElement('div');
    const menuItem = document.createElement('button');
    const accountButton = document.createElement('button');
    menu.setAttribute('role', 'menu');
    menu.append(menuItem);
    document.body.append(menu, accountButton);
    menuItem.focus();

    render(<Harness trigger={accountButton} />);
    await user.click(await screen.findByRole('button', { name: 'Close' }));

    await waitFor(() => expect(accountButton).toHaveFocus());
  });
});
