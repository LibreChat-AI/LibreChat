import { EModelEndpoint } from 'librechat-data-provider';
import { useFormContext, Controller } from 'react-hook-form';
import InputWithLabel from './InputWithLabel';

const OpenAIConfig = ({
  endpoint,
  userProvideURL,
}: {
  endpoint: EModelEndpoint | string;
  userProvideURL?: boolean | null;
}) => {
  const { control } = useFormContext();
  const isAzure = endpoint === EModelEndpoint.azureOpenAI;
  return (
    <form className="flex-wrap">
      {!isAzure && (
        <Controller
          name="apiKey"
          control={control}
          render={({ field }) => (
            <InputWithLabel
              id="apiKey"
              {...field}
              label={`${isAzure ? 'Azure q' : ''}OpenAI API Key`}
              labelClassName="mb-1"
              inputClassName="mb-2"
              secret
            />
          )}
        />
      )}
      {isAzure && (
        <>
          <Controller
            name="azureOpenAIApiKey"
            control={control}
            render={({ field }) => (
              <InputWithLabel
                id="azureOpenAIApiKey"
                {...field}
                label={'Azure OpenAI API Key'}
                labelClassName="mb-1"
                secret
              />
            )}
          />
          <div className="mt-3"></div>
          <Controller
            name="azureOpenAIApiInstanceName"
            control={control}
            render={({ field }) => (
              <InputWithLabel
                id="azureOpenAIApiInstanceName"
                {...field}
                label={'Azure OpenAI Instance Name'}
                labelClassName="mb-1"
              />
            )}
          />
          <div className="mt-3"></div>
          <Controller
            name="azureOpenAIApiDeploymentName"
            control={control}
            render={({ field }) => (
              <InputWithLabel
                id="azureOpenAIApiDeploymentName"
                {...field}
                label={'Azure OpenAI Deployment Name'}
                labelClassName="mb-1"
              />
            )}
          />
          <div className="mt-3"></div>
          <Controller
            name="azureOpenAIApiVersion"
            control={control}
            render={({ field }) => (
              <InputWithLabel
                id="azureOpenAIApiVersion"
                {...field}
                label={'Azure OpenAI API Version'}
                labelClassName="mb-1"
              />
            )}
          />
        </>
      )}
      {userProvideURL && (
        <div className="mt-3">
          <Controller
            name="baseURL"
            control={control}
            render={({ field }) => (
              <InputWithLabel
                id="baseURL"
                {...field}
                label={'API Base URL'}
                subLabel={'(Optional)'}
                labelClassName="mb-1"
              />
            )}
          />
        </div>
      )}
    </form>
  );
};

export default OpenAIConfig;
