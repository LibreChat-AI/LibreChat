import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { ThemeProvider, clickHouseTheme } from '@librechat/client';
import './style.css';
import { App } from './App';
import i18n from './i18n';

const params = new URLSearchParams(window.location.search);
const themeDefinition = params.get('theme') === 'clickhouse' ? clickHouseTheme : undefined;
const mode = params.get('mode');
const initialTheme = mode === 'dark' || mode === 'light' ? mode : 'system';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider
          initialTheme={initialTheme}
          themeDefinition={themeDefinition}
          persistThemeDefinition={false}
        >
          <App />
        </ThemeProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}
