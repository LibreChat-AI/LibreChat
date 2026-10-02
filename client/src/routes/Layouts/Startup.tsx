import { useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import type { TStartupConfig } from 'librechat-data-provider';
import { REDIRECT_PARAM, hasStoredRedirect } from '~/utils';
import { TranslationKeys, useLocalize } from '~/hooks';
import { useGetStartupConfig } from '~/data-provider';
import AuthLayout from '~/components/Auth/AuthLayout';

const headerMap: Record<string, TranslationKeys> = {
  '/login': 'com_auth_welcome_back',
  '/register': 'com_auth_create_account',
  '/forgot-password': 'com_auth_reset_password',
  '/reset-password': 'com_auth_reset_password',
  '/login/2fa': 'com_auth_verify_your_identity',
};

export default function StartupLayout({ isAuthenticated }: { isAuthenticated?: boolean }) {
  const [error, setError] = useState<TranslationKeys | null>(null);
  const [headerText, setHeaderText] = useState<TranslationKeys | null>(null);
  const [startupConfig, setStartupConfig] = useState<TStartupConfig | null>(null);
  const {
    data,
    isFetching,
    error: startupConfigError,
  } = useGetStartupConfig({
    enabled: isAuthenticated ? startupConfig === null : true,
  });
  const localize = useLocalize();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (isAuthenticated) {
      const hasPendingRedirect =
        new URLSearchParams(window.location.search).has(REDIRECT_PARAM) || hasStoredRedirect();
      if (!hasPendingRedirect) {
        navigate('/c/new', { replace: true });
      }
    }
    if (data) {
      setStartupConfig(data);
    }
  }, [isAuthenticated, navigate, data]);

  useEffect(() => {
    document.title = startupConfig?.appTitle || 'LibreChat';

    // Method to replace favicon link/href value
    const updateFavicon = (size: '16x16' | '32x32', filename: string) => {
      const faviconLink = document.querySelector(`link[rel="icon"][sizes="${size}"]`) as HTMLLinkElement;

      if (faviconLink) {
        faviconLink.href = filename;
      } else {
        // Optional: If no favicon link exists, then create one
        const newLink = document.createElement('link');
        newLink.rel = 'icon';
        newLink.type = 'image/png';
        newLink.sizes = size;
        newLink.href = filename;
        document.head.appendChild(newLink);
      }
    };

    const favicon_16 = startupConfig?.appFavicon16 || 'assets/favicon-16x16.png';
    updateFavicon('16x16', favicon_16);

    const favicon_32 = startupConfig?.appFavicon32 || 'assets/favicon-32x32.png';
    updateFavicon('32x32', favicon_32);
  }, [startupConfig?.appTitle]);

  useEffect(() => {
    setError(null);
    setHeaderText(null);
  }, [location.pathname]);

  const contextValue = {
    error,
    setError,
    headerText,
    setHeaderText,
    startupConfigError,
    startupConfig,
    isFetching,
  };

  return (
    <AuthLayout
      header={headerText ? localize(headerText) : localize(headerMap[location.pathname])}
      isFetching={isFetching}
      startupConfig={startupConfig}
      startupConfigError={startupConfigError}
      pathname={location.pathname}
      error={error}
    >
      <Outlet context={contextValue} />
    </AuthLayout>
  );
}
