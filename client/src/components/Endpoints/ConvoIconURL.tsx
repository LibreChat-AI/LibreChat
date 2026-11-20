import { memo, useMemo } from 'react';
import { ProviderIcon } from '@librechat/client';
import type { ProviderId } from 'librechat-data-provider';
import { URLIcon } from '~/components/Endpoints/URLIcon';
import { isImageURL } from '~/utils/icons';

interface ConvoIconURLProps {
  iconURL?: string;
  modelLabel?: string | null;
  provider?: ProviderId | null;
  assistantName?: string;
  agentName?: string;
  context?: 'landing' | 'menu-item' | 'nav' | 'message';
  assistantAvatar?: string;
  agentAvatar?: string;
}

const classMap = {
  'menu-item': 'relative flex h-full items-center justify-center overflow-hidden rounded-full',
  message: 'icon-md',
  default: 'icon-xl relative flex h-full overflow-hidden rounded-full',
};

const styleMap = {
  /** 1.25rem is 20px at the 16px baseline, and follows the UI scale. */
  'menu-item': { width: '1.25rem', height: '1.25rem' },
  default: { width: '100%', height: '100%' },
};

const styleImageMap = {
  default: { width: '100%', height: '100%' },
};

const ConvoIconURL: React.FC<ConvoIconURLProps> = ({
  iconURL = '',
  modelLabel = '',
  provider,
  context,
}) => {
  const isURL = useMemo(() => isImageURL(iconURL), [iconURL]);
  if (isURL) {
    return (
      <URLIcon
        iconURL={iconURL}
        altName={modelLabel}
        className={classMap[context ?? 'default'] ?? classMap.default}
        containerStyle={styleMap[context ?? 'default'] ?? styleMap.default}
        imageStyle={styleImageMap[context ?? 'default'] ?? styleImageMap.default}
      />
    );
  }

  return (
    <div className="avatar-stroke bg-surface-primary text-text-primary relative flex h-full items-center justify-center rounded-full">
      <ProviderIcon provider={provider} size={41} className="h-2/3 w-2/3" />
    </div>
  );
};

export default memo(ConvoIconURL);
