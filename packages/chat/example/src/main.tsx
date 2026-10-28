import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, clickHouseTheme } from '@librechat/client';
import './style.css';
import './i18n';
import { App } from './App';

const params = new URLSearchParams(window.location.search);
const themeDefinition = params.get('theme') === 'clickhouse' ? clickHouseTheme : undefined;
const mode = params.get('mode');
const initialTheme = mode === 'dark' || mode === 'light' ? mode : 'system';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider
        initialTheme={initialTheme}
        themeDefinition={themeDefinition}
        persistThemeDefinition={false}
      >
        <App />
      </ThemeProvider>
    </StrictMode>,
  );
}
