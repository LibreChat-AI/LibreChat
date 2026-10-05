import { useState } from 'react';
import { Button, Label } from '@librechat/client';
import { useMediaSessionGuard } from '~/components/Media/session';
import { MediaDeleteDialog } from '~/components/Media/Delete';
import { useLocalize, useMediaAccess } from '~/hooks';

export function ClearCreations() {
  const localize = useLocalize();
  const access = useMediaAccess();
  const isCurrentSession = useMediaSessionGuard(access.scope, access.isAuthenticated);
  const [open, setOpen] = useState(false);
  if (!access.studio || !access.scope) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <Label id="clear-creations-label">{localize('com_ui_settings_label_clear_creations')}</Label>
      <Button
        variant="destructive"
        aria-labelledby="clear-creations-label"
        onClick={() => setOpen(true)}
      >
        {localize('com_ui_delete')}
      </Button>
      <MediaDeleteDialog
        host={{ scope: access.scope, isCurrentSession }}
        request={{ mode: 'all' }}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
