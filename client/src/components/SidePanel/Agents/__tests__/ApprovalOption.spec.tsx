import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from 'test/layout-test-utils';
import ApprovalOption from '../ApprovalOption';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

test('opens the four modes and inheritance without changing tool selection', async () => {
  const onChange = jest.fn();
  render(<ApprovalOption mode="chat" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button'));
  const item = await screen.findByRole('menuitemcheckbox', { name: 'com_ui_tool_approval_always' });
  fireEvent.click(item);
  expect(onChange).toHaveBeenCalledWith('always');
});

test('bulk menu reports mixed state and clears to inheritance', async () => {
  const onChange = jest.fn();
  render(<ApprovalOption bulk={true} mode="mixed" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(
    await screen.findByRole('menuitemcheckbox', { name: 'com_ui_tool_approval_inherit' }),
  );
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(undefined));
});

test('administrator-required approval disables automatic modes', async () => {
  render(<ApprovalOption constraint="ask" onChange={jest.fn()} />);
  fireEvent.click(screen.getByRole('button'));
  const allow = await screen.findByRole('menuitemcheckbox', { name: 'com_ui_tool_approval_allow' });
  expect(allow).toHaveAttribute('aria-disabled', 'true');
});
