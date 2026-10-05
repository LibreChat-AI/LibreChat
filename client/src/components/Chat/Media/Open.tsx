import { useContext } from 'react';
import { useStore } from 'jotai';
import { Images } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, TooltipAnchor } from '@librechat/client';
import { mediaAssetSchema } from 'librechat-data-provider';
import type { TMediaFileRef } from '~/common';
import { openMediaEditDraft } from '~/components/Media/seeding';
import { mediaSessionScope } from '~/components/Media/session';
import { AuthContext } from '~/hooks/AuthContext';
import { useFileMapContext } from '~/Providers';
import { useLocalize } from '~/hooks';

/** Existing authorized Files are reused by ID; opening the editor makes no provider call. The
 * host decides whether Studio is offered at all (see `Chat/Studio`); this only checks that the
 * file describes a usable asset, and touches the draft atom only when the reader acts. */
export function useOpenInStudio(file: TMediaFileRef) {
  const auth = useContext(AuthContext);
  const fileMap = useFileMapContext();
  const store = useStore();
  const navigate = useNavigate();
  const source = { ...(file.file_id ? fileMap?.[file.file_id] : undefined), ...file };
  const parsed = mediaAssetSchema.safeParse({
    file_id: source.file_id,
    filename: source.filename,
    filepath: source.filepath,
    type: source.type,
    bytes: source.bytes,
    width: source.width,
    height: source.height,
  });
  const user = auth?.user;
  if (!user || !parsed.success) return null;
  const asset = parsed.data;
  return () => {
    openMediaEditDraft(store, mediaSessionScope(user), [asset]);
    navigate('/studio');
  };
}
export default function OpenInStudio({ file }: { file: TMediaFileRef }) {
  const open = useOpenInStudio(file);
  const localize = useLocalize();
  if (!open) return null;
  return (
    <TooltipAnchor
      description={localize('com_media_open_studio')}
      render={
        <Button
          variant="outline"
          size="icon"
          aria-label={localize('com_media_open_studio')}
          onClick={open}
        >
          <Images className="size-5" aria-hidden="true" />
        </Button>
      }
    />
  );
}
