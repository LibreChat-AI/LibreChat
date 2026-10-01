import { Feather } from 'lucide-react';
import { EModelEndpoint, alternateName } from 'librechat-data-provider';
import { pxToRem, Sparkles, ProviderIcon, getProviderIconDef } from '@librechat/client';
import type { IconProps } from '~/common';
import { useProviderIcon } from '~/hooks/Endpoint';
import { cn } from '~/utils';

/** The art stays at `icon-sm` and never outgrows the wrapper it sits in. */
const maxArtSize = 16;

const MinimalIcon: React.FC<IconProps> = (props) => {
  const {
    size = 30,
    iconURL = '',
    iconClassName,
    error,
    model,
    modelLabel,
    chatGptLabel,
    endpointsConfig,
  } = props;
  const endpoint = typeof props.endpoint === 'string' ? props.endpoint : '';
  const { provider, imageURL } = useProviderIcon({ endpoint, iconURL, endpointsConfig });

  const renderWrapper = (icon: React.ReactNode, name: string) => (
    <div
      data-testid="convo-icon"
      title={name}
      aria-hidden="true"
      style={{
        width: pxToRem(size),
        height: pxToRem(size),
      }}
      className={cn(
        'text-text-secondary relative flex items-center justify-center rounded-sm',
        props.className ?? '',
      )}
    >
      {icon}
      {error === true && (
        <span className="border-surface-primary bg-status-error-strong text-text-on-status absolute top-[1.25rem] right-0 -mr-2 flex h-4 w-4 items-center justify-center rounded-full border text-[0.625rem]">
          !
        </span>
      )}
    </div>
  );

  if (endpoint === EModelEndpoint.agents) {
    return renderWrapper(
      <Feather className="icon-sm" aria-hidden="true" />,
      modelLabel ?? alternateName[EModelEndpoint.agents],
    );
  }

  if (endpoint === EModelEndpoint.assistants || endpoint === EModelEndpoint.azureAssistants) {
    return renderWrapper(<Sparkles className="icon-sm" />, 'Assistant');
  }

  const def = getProviderIconDef(provider, model);
  const name = modelLabel ?? chatGptLabel ?? (provider != null ? def.label : endpoint || def.label);

  if (imageURL != null) {
    return renderWrapper(
      <img className={cn('icon-sm', iconClassName)} src={imageURL} alt={`${endpoint} Icon`} />,
      name,
    );
  }

  return renderWrapper(
    <ProviderIcon
      provider={provider}
      model={model}
      size={Math.min(size, maxArtSize)}
      className={iconClassName}
    />,
    name,
  );
};

export default MinimalIcon;
