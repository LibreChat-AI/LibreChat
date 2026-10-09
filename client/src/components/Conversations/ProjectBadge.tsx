import { memo } from 'react';
import { Folder } from 'lucide-react';
import { useProjectName } from '~/data-provider';
import { useLocalize } from '~/hooks';

/** Marks a row listed outside its project, such as a project chat under Chats, so it
 *  reads as filed elsewhere rather than as a chat with no project. */
function ProjectBadge({ projectId, labelId }: { projectId: string; labelId: string }) {
  const localize = useLocalize();
  const name = useProjectName(projectId);
  const label = name ? localize('com_ui_in_project', { name }) : localize('com_ui_project');

  return (
    <span
      className="text-text-secondary mr-1 flex shrink-0 items-center"
      title={label}
      data-testid="convo-project-badge"
    >
      <Folder className="icon-sm" aria-hidden="true" />
      <span id={labelId} className="sr-only">
        {label}
      </span>
    </span>
  );
}

export default memo(ProjectBadge);
