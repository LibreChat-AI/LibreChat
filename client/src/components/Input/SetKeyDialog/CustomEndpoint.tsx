import { EModelEndpoint } from 'librechat-data-provider';
import { useFormContext, Controller } from 'react-hook-form';
import InputWithLabel from './InputWithLabel';
import { useLocalize } from '~/hooks';

const CustomEndpoint = ({
  endpoint,
  userProvideURL,
}: {
  endpoint: EModelEndpoint | string;
  userProvideURL?: boolean | null;
}) => {
  const {
    control,
    formState: { errors },
  } = useFormContext();
  const localize = useLocalize();
  return (
    <form className="flex-wrap">
      <Controller
        name="apiKey"
        control={control}
        render={({ field }) => (
          <InputWithLabel
            id="apiKey"
            {...field}
            label={localize('com_endpoint_config_api_key_label', { name: endpoint })}
            labelClassName="mb-1"
            inputClassName="mb-2"
            secret
          />
        )}
      />
      {errors.apiKey?.message && (
        <p role="alert" className="text-text-destructive text-sm">
          {String(errors.apiKey.message)}
        </p>
      )}
      {userProvideURL && (
        <Controller
          name="baseURL"
          control={control}
          render={({ field }) => (
            <InputWithLabel
              id="baseURL"
              {...field}
              label={localize('com_endpoint_config_api_url_label', { name: endpoint })}
              labelClassName="mb-1"
            />
          )}
        />
      )}
      {errors.baseURL?.message && (
        <p role="alert" className="text-text-destructive text-sm">
          {String(errors.baseURL.message)}
        </p>
      )}
    </form>
  );
};

export default CustomEndpoint;
