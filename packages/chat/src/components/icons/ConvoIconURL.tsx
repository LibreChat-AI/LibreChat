import { memo, useMemo } from 'react';
import { ProviderIcon } from '@librechat/client';
import type { NamedExoticComponent, ReactNode } from 'react';
import type { ProviderId } from 'librechat-data-provider';
import { isImageURL } from '../../core/icons';
import { URLIcon } from './URLIcon';

export interface ConvoIconURLProps {
  iconURL?: string;
  modelLabel?: string | null;
  provider?: ProviderId | null;
  assistantName?: string;
  agentName?: string;
  context?: 'landing' | 'menu-item' | 'nav' | 'message';
  assistantAvatar?: string;
  agentAvatar?: string;
}

type IconContext = NonNullable<ConvoIconURLProps['context']> | 'default';

const classMap: Partial<Record<IconContext, string>> & { default: string } = {
  'menu-item': 'relative flex h-full items-center justify-center overflow-hidden rounded-full',
  message: 'icon-md',
  default: 'icon-xl relative flex h-full overflow-hidden rounded-full',
};

/** 1.25rem is 20px at the 16px baseline, and follows the UI scale. */
const sizeMap: Partial<Record<IconContext, string>> & { default: string } = {
  'menu-item': '1.25rem',
  default: '100%',
};

function ConvoIconURLBody({
  iconURL = '',
  modelLabel = '',
  provider,
  context,
}: ConvoIconURLProps): ReactNode {
  const isURL = useMemo(() => isImageURL(iconURL), [iconURL]);
  if (isURL) {
    return (
      <URLIcon
        iconURL={iconURL}
        altName={modelLabel}
        className={classMap[context ?? 'default'] ?? classMap.default}
        size={sizeMap[context ?? 'default'] ?? sizeMap.default}
      />
    );
  }

  return (
    <div className="avatar-stroke bg-surface-primary text-text-primary relative flex h-full items-center justify-center rounded-full">
      <ProviderIcon provider={provider} size={41} className="h-2/3 w-2/3" />
    </div>
  );
}

/** An icon a conversation or message names by URL, or the provider's icon when it names none. */
const ConvoIconURL: NamedExoticComponent<ConvoIconURLProps> = memo(ConvoIconURLBody);

export default ConvoIconURL;
