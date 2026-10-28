import { memo, useCallback, useEffect } from 'react';
import { useToastContext } from '@librechat/client';
import { useFormContext, useWatch } from 'react-hook-form';
import { mergeFileConfig, fileConfig as defaultFileConfig } from 'librechat-data-provider';
import type { AgentAvatar } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { AgentAvatarRender, NoImage, AvatarMenu } from './Images';
import { useGetFileConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

function Avatar({ avatar }: { avatar: AgentAvatar | null }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { control, setValue } = useFormContext<AgentForm>();
  const avatarPreview = useWatch({ control, name: 'avatar_preview' }) ?? '';
  const avatarAction = useWatch({ control, name: 'avatar_action' });
  const { data: fileConfig = defaultFileConfig } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });

  // Derive whether agent has a remote avatar from the avatar prop
  const hasRemoteAvatar = Boolean(avatar?.filepath);

  useEffect(() => {
    if (avatarAction) {
      return;
    }

    if (avatar?.filepath && avatarPreview !== avatar.filepath) {
      setValue('avatar_preview', avatar.filepath);
    }

    if (!avatar?.filepath && avatarPreview !== '') {
      setValue('avatar_preview', '');
    }
  }, [avatar?.filepath, avatarAction, avatarPreview, setValue]);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      const sizeLimit = fileConfig.avatarSizeLimit ?? 0;

      if (!file) {
        return;
      }

      if (sizeLimit && file.size > sizeLimit) {
        const limitInMb = sizeLimit / (1024 * 1024);
        const displayLimit = Number.isInteger(limitInMb)
          ? limitInMb
          : parseFloat(limitInMb.toFixed(1));
        showToast({
          message: localize('com_ui_upload_invalid_var', { 0: displayLimit }),
          status: 'error',
        });
        return;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        setValue('avatar_file', file, { shouldDirty: true });
        setValue('avatar_preview', (reader.result as string) ?? '', { shouldDirty: true });
        setValue('avatar_action', 'upload', { shouldDirty: true });
      };
      reader.readAsDataURL(file);
    },
    [fileConfig.avatarSizeLimit, localize, setValue, showToast],
  );

  const handleReset = useCallback(() => {
    const remoteAvatarExists = Boolean(avatar?.filepath);
    setValue('avatar_preview', '', { shouldDirty: true });
    setValue('avatar_file', null, { shouldDirty: true });
    setValue('avatar_action', remoteAvatarExists ? 'reset' : null, { shouldDirty: true });
  }, [avatar?.filepath, setValue]);

  const hasIcon = Boolean(avatarPreview) || hasRemoteAvatar;
  const canReset = hasIcon;

  return (
    <AvatarMenu
      trigger={
        <button
          type="button"
          className="focus-visible:ring-text-primary h-14 w-14 overflow-hidden rounded-full ring-offset-0 outline-hidden transition-shadow focus:outline-hidden focus-visible:ring-2"
          aria-label={localize('com_ui_upload_agent_avatar_label')}
        >
          <span
            className="t-icon-swap block h-full w-full"
            data-state={avatarPreview ? 'a' : 'b'}
            aria-hidden="true"
          >
            <span className="t-icon block h-full w-full" data-icon="a">
              <AgentAvatarRender url={avatarPreview} />
            </span>
            <span className="t-icon block h-full w-full" data-icon="b">
              <NoImage />
            </span>
          </span>
        </button>
      }
      handleFileChange={handleFileChange}
      onReset={handleReset}
      canReset={canReset}
    />
  );
}

const MemoizedAvatar = memo(
  Avatar,
  (prevProps, nextProps) => prevProps.avatar?.filepath === nextProps.avatar?.filepath,
);
MemoizedAvatar.displayName = 'Avatar';

export default MemoizedAvatar;
