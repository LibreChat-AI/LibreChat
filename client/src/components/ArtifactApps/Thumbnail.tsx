import { Shapes } from 'lucide-react';
import { isAllowedArtifactPreviewUrl, type TArtifactApp } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

export default function Thumbnail({ app }: { app: TArtifactApp }) {
  const localize = useLocalize();
  const preview =
    app.preview?.type === 'image' && isAllowedArtifactPreviewUrl(app.preview.imageUrl)
      ? app.preview
      : undefined;

  return (
    <div
      className="pointer-events-none relative aspect-[3/2] w-full overflow-hidden bg-surface-primary"
      aria-hidden="true"
    >
      {preview ? (
        <img
          src={preview.imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover object-top"
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-text-secondary">
          <Shapes className="size-6 opacity-50" aria-hidden="true" />
          <span>{localize('com_ui_artifact_app_preview_unavailable')}</span>
        </div>
      )}
    </div>
  );
}
