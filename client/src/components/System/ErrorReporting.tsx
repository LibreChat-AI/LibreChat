import { useEffect } from 'react';
import { startErrorReporting } from '~/lib/reporting';
import { useGetStartupConfig } from '~/data-provider';

/** Starts browser error reporting once the startup config says it is on. Renders nothing. */
export default function ErrorReporting() {
  const { data: startupConfig } = useGetStartupConfig();
  const config = startupConfig?.errorReporting;

  useEffect(() => {
    void startErrorReporting(config);
  }, [config]);

  return null;
}
