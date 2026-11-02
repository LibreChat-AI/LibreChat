import { memo } from 'react';
import { FilePlus, FolderPlus, Upload } from 'lucide-react';
import { useLocalize } from '~/hooks';

interface TreeToolbarProps {
  onNewFile: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
}

function TreeToolbar({ onNewFile, onNewFolder, onUpload }: TreeToolbarProps) {
  const localize = useLocalize();

  return (
    <div
      className="flex items-center gap-0.5 px-1.5 py-1"
      role="toolbar"
      aria-label={localize('com_ui_skill_content')}
    >
      <button
        type="button"
        className="text-text-tertiary hover:bg-surface-hover hover:text-text-secondary rounded-md bg-transparent p-1 transition-colors duration-100"
        onClick={onNewFile}
        aria-label={localize('com_ui_skill_new_file')}
        title={localize('com_ui_skill_new_file')}
      >
        <FilePlus className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="text-text-tertiary hover:bg-surface-hover hover:text-text-secondary rounded-md bg-transparent p-1 transition-colors duration-100"
        onClick={onNewFolder}
        aria-label={localize('com_ui_skill_new_folder')}
        title={localize('com_ui_skill_new_folder')}
      >
        <FolderPlus className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="text-text-tertiary hover:bg-surface-hover hover:text-text-secondary rounded-md bg-transparent p-1 transition-colors duration-100"
        onClick={onUpload}
        aria-label={localize('com_ui_skill_upload_file')}
        title={localize('com_ui_skill_upload_file')}
      >
        <Upload className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export default memo(TreeToolbar);
