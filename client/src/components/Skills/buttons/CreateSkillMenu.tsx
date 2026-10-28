import { useMemo, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import { Plus, PenLine, Upload } from 'lucide-react';
import { DropdownPopup, TooltipAnchor } from '@librechat/client';
import type { MenuItemProps } from '@librechat/client';
import { CreateSkillDialog, UploadSkillDialog } from '../dialogs';
import { useLocalize } from '~/hooks';

export default function CreateSkillMenu() {
  const localize = useLocalize();
  const [isOpen, setIsOpen] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const createLabel = localize('com_ui_create_skill');

  const items: MenuItemProps[] = useMemo(
    () => [
      {
        label: localize('com_ui_skill_write_instructions'),
        onClick: () => setWriteOpen(true),
        icon: <PenLine className="icon-md" aria-hidden="true" />,
      },
      {
        label: localize('com_ui_skill_upload'),
        onClick: () => setUploadOpen(true),
        icon: <Upload className="icon-md" aria-hidden="true" />,
      },
    ],
    [localize],
  );

  return (
    <>
      <DropdownPopup
        gutter={2}
        menuId="create-skill-menu"
        isOpen={isOpen}
        setIsOpen={setIsOpen}
        unmountOnHide={true}
        trigger={
          <TooltipAnchor
            description={createLabel}
            side="bottom"
            render={
              <Ariakit.MenuButton
                aria-label={createLabel}
                className="text-text-primary hover:bg-surface-hover focus-visible:ring-text-primary inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors focus:outline-hidden focus-visible:ring-2"
              >
                <Plus className="size-4" aria-hidden="true" />
              </Ariakit.MenuButton>
            }
          />
        }
        items={items}
      />
      <CreateSkillDialog isOpen={writeOpen} setIsOpen={setWriteOpen} />
      <UploadSkillDialog isOpen={uploadOpen} setIsOpen={setUploadOpen} />
    </>
  );
}
