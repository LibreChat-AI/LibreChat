import React from 'react';
import { RecoilRoot } from 'recoil';
import { createInstance } from 'i18next';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@librechat/client';
import { render, screen } from '@testing-library/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TUser } from 'librechat-data-provider';
import BackupCodesItem from '~/components/Nav/SettingsTabs/Account/BackupCodesItem';
import DeleteButton from '~/components/Conversations/ConvoOptions/DeleteButton';
import frenchTranslation from '~/locales/fr/translation.json';
import { AuthContextProvider } from '~/hooks/AuthContext';
import store from '~/store';

jest.unmock('react-i18next');

const user: TUser = {
  id: 'localized-buttons-user',
  username: 'test-user',
  email: 'test@example.com',
  name: 'Test User',
  avatar: '',
  role: 'USER',
  provider: 'local',
  twoFactorEnabled: true,
  backupCodes: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

async function renderInFrench(ui: React.ReactElement) {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'fr',
    fallbackLng: 'fr',
    resources: { fr: { translation: frenchTranslation } },
    interpolation: { escapeValue: false },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.user, user);
            set(store.queriesEnabled, false);
          }}
        >
          <MemoryRouter>
            <AuthContextProvider authConfig={{ loginRedirect: '', test: true }}>
              <ToastProvider>{ui}</ToastProvider>
            </AuthContextProvider>
          </MemoryRouter>
        </RecoilRoot>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe('localized button names', () => {
  it('names the cancel button with its French visible text', async () => {
    await renderInFrench(
      <DeleteButton
        conversationId="conversation-1"
        title="Bonjour"
        retainView={jest.fn()}
        showDeleteDialog={true}
        setShowDeleteDialog={jest.fn()}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Annuler' })).toHaveTextContent('Annuler');
  });

  it('names the manage button with its French visible text', async () => {
    await renderInFrench(<BackupCodesItem />);

    expect(screen.getByRole('button', { name: 'Gérer' })).toHaveTextContent('Gérer');
  });
});
