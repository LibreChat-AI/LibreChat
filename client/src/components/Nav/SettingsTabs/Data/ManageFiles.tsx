import { useRef, useState } from 'react';
import { Label, Button } from '@librechat/client';
import { MyFilesModal } from '~/components/Chat/Input/Files/MyFilesModal';
import { useLocalize } from '~/hooks';

export const ManageFiles = () => {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="flex items-center justify-between">
      <Label id="manage-files-label">{localize('com_sidepanel_manage_files')}</Label>
      <Button
        ref={triggerRef}
        variant="outline"
        onClick={() => setOpen(true)}
        aria-labelledby="manage-files-label"
      >
        {localize('com_ui_manage')}
      </Button>
      {open && <MyFilesModal open={open} onOpenChange={setOpen} triggerRef={triggerRef} />}
    </div>
  );
};
