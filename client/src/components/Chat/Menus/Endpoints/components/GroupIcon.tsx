import React, { memo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { pxToRem, ProviderIcon } from '@librechat/client';
import { resolveProviderId } from 'librechat-data-provider';
import { EntityEndpointMark, isEntityEndpoint } from '~/components/Endpoints/EntityEndpointMark';
import CustomIcon from '~/components/ui/CustomIcon';
import { isImageURL } from '~/utils/icons';

interface GroupIconProps {
  iconURL: string;
  groupName: string;
}

const GroupIcon: React.FC<GroupIconProps> = ({ iconURL, groupName }) => {
  const [imageError, setImageError] = useState(false);
  const provider = resolveProviderId(iconURL);

  const handleImageError = () => {
    setImageError(true);
  };

  if (isEntityEndpoint(iconURL)) {
    return (
      <div
        className="relative"
        style={{ width: pxToRem(20), height: pxToRem(20), margin: pxToRem(2) }}
        title={groupName}
      >
        <EntityEndpointMark endpoint={iconURL} />
      </div>
    );
  }

  if (provider || !isImageURL(iconURL) || imageError) {
    return (
      <div
        className="relative"
        style={{ width: pxToRem(20), height: pxToRem(20), margin: pxToRem(2) }}
      >
        <ProviderIcon provider={provider} size={20} className="icon-md shrink-0" />
        {imageError && (
          <div
            className="bg-surface-destructive absolute flex items-center justify-center rounded-full"
            style={{ width: pxToRem(14), height: pxToRem(14), top: 0, right: 0 }}
          >
            <AlertCircle className="text-text-on-status size-2.5" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="icon-md text-text-primary shrink-0 overflow-hidden rounded-full"
      style={{ width: pxToRem(20), height: pxToRem(20) }}
    >
      <CustomIcon
        src={iconURL}
        alt={groupName}
        className="h-full w-full object-cover"
        onError={handleImageError}
      />
    </div>
  );
};

export default memo(GroupIcon);
