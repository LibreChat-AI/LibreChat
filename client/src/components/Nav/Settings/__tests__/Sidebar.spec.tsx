import * as Tabs from '@radix-ui/react-tabs';
import userEvent from '@testing-library/user-event';
import { SettingsTabValues } from 'librechat-data-provider';
import type { SettingsContextValue } from '../types';
import { render, screen } from 'test/layout-test-utils';
import Sidebar from '../Sidebar';

const ctx: SettingsContextValue = {
  balanceEnabled: false,
  hasAnyPersonalizationFeature: false,
  hasMemoryOptOut: false,
  hasStatefulCodeSessions: false,
  hasRemoteAgents: false,
  hasUserProvidedEndpoints: false,
  hasMultiConvo: false,
  hasPrompts: false,
  isLocalProvider: true,
  emailEnabled: true,
  allowEmailChange: true,
  passkeyLoginEnabled: false,
  twoFactorEnabled: false,
  allowAccountDeletion: true,
  aboutEnabled: false,
  engineTTS: 'browser',
  langfuseConnectionAccess: false,
  adminPanelURL: '',
  replyTabBadgeAllowed: true,
  replyNotificationsAllowed: true,
  replyNotificationSoundAllowed: true,
};

function setup(extra: Partial<SettingsContextValue> = {}, query = '') {
  const onQueryChange = jest.fn();
  render(
    <Tabs.Root value={SettingsTabValues.GENERAL}>
      <Sidebar
        ctx={{ ...ctx, ...extra }}
        query={query}
        onQueryChange={onQueryChange}
        onSelectTab={jest.fn()}
      />
    </Tabs.Root>,
  );
  return { onQueryChange };
}

describe('Sidebar', () => {
  it('hides the About tab when build info is disabled', () => {
    setup();
    expect(screen.queryByText('About')).not.toBeInTheDocument();
  });

  it('shows the About tab when build info is enabled', () => {
    setup({ aboutEnabled: true });
    expect(screen.getByText('About')).toBeInTheDocument();
  });

  it('shows the Langfuse tab when Langfuse is available to the user', () => {
    setup({ langfuseConnectionAccess: true });
    expect(screen.getByText('Langfuse')).toBeInTheDocument();
  });

  it('hides the Langfuse tab without Langfuse connection access', () => {
    setup({ langfuseConnectionAccess: false });
    expect(screen.queryByText('Langfuse')).not.toBeInTheDocument();
  });

  it('forwards typing to onQueryChange', async () => {
    const { onQueryChange } = setup();
    await userEvent.type(screen.getByRole('textbox'), 'theme');
    expect(onQueryChange).toHaveBeenCalled();
  });

  it('Escape clears search when query is non-empty', async () => {
    const { onQueryChange } = setup({}, 'theme');
    const input = screen.getByRole('textbox');
    input.focus();
    await userEvent.keyboard('{Escape}');
    expect(onQueryChange).toHaveBeenCalledWith('');
  });

  it('Escape does not call onQueryChange when query is empty', async () => {
    const { onQueryChange } = setup({}, '');
    const input = screen.getByRole('textbox');
    input.focus();
    await userEvent.keyboard('{Escape}');
    expect(onQueryChange).not.toHaveBeenCalled();
  });

  it('shows a clear button that clears the query when there is text', async () => {
    const { onQueryChange } = setup({}, 'theme');
    await userEvent.click(screen.getByRole('button', { name: /clear search/i }));
    expect(onQueryChange).toHaveBeenCalledWith('');
  });

  it('hides the clear button when the query is empty', () => {
    setup({}, '');
    expect(screen.queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument();
  });
});
