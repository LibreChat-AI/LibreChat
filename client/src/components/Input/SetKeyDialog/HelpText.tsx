import { memo } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

function HelpText({ endpoint }: { endpoint: string }) {
  const localize = useLocalize();
  const textMap = {
    [EModelEndpoint.google]: (
      <>
        <small className="mt-4 break-all text-text-secondary">
          {localize('com_endpoint_config_google_service_key')}
          {': '}
          {localize('com_endpoint_config_key_google_need_to')}{' '}
          <a
            target="_blank"
            href="https://console.cloud.google.com/vertex-ai"
            rel="noreferrer"
            className="text-link underline"
          >
            {localize('com_endpoint_config_key_google_vertex_ai')}
          </a>{' '}
          {localize('com_endpoint_config_key_google_vertex_api')}{' '}
          <a
            target="_blank"
            href="https://console.cloud.google.com/projectselector/iam-admin/serviceaccounts/create?walkthrough_id=iam--create-service-account#step_index=1"
            rel="noreferrer"
            className="text-link underline"
          >
            {localize('com_endpoint_config_key_google_service_account')}
          </a>
          {'. '}
          {localize('com_endpoint_config_key_google_vertex_api_role')}
        </small>
        <small className="break-all text-text-secondary">
          {localize('com_endpoint_config_google_api_key')}
          {': '}
          {localize('com_endpoint_config_google_api_info')}{' '}
          <a
            target="_blank"
            href="https://makersuite.google.com/app/apikey"
            rel="noreferrer"
            className="text-link underline"
          >
            {localize('com_endpoint_config_click_here')}
          </a>{' '}
        </small>
      </>
    ),
  };

  return textMap[endpoint] || null;
}

export default memo(HelpText);
