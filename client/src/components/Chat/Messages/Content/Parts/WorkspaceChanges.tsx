import { memo, useId, useMemo, useState } from 'react';
import { Button, IconButton } from '@librechat/client';
import { ChevronDown, Download, Files } from 'lucide-react';
import type {
  TAttachment,
  TFile,
  WorkspaceChange as WorkspaceChangeMetadata,
} from 'librechat-data-provider';
import { useExpandCollapse, useLocalize } from '~/hooks';
import { useAttachmentLink } from './LogLink';
import { cn } from '~/utils';

type StatefulWorkspaceAttachment = TAttachment & {
  workspaceChange: WorkspaceChangeMetadata;
};

export function partitionWorkspaceChanges(attachments?: TAttachment[]): {
  inlineAttachments: TAttachment[];
  workspaceChanges: StatefulWorkspaceAttachment[];
} {
  const inlineAttachments: TAttachment[] = [];
  const changesByFile = new Map<string, StatefulWorkspaceAttachment>();

  for (const attachment of attachments ?? []) {
    const change = attachment.workspaceChange;
    if (change?.profile !== 'stateful' || !attachment.filepath) {
      inlineAttachments.push(attachment);
      continue;
    }

    const file = attachment as Partial<TFile> & { agentId?: string };
    const key = file.file_id ?? `${file.agentId ?? ''}:${change.path}`;
    changesByFile.delete(key);
    changesByFile.set(key, attachment as StatefulWorkspaceAttachment);
  }

  return { inlineAttachments, workspaceChanges: Array.from(changesByFile.values()) };
}

const WorkspaceChange = memo(({ attachment }: { attachment: StatefulWorkspaceAttachment }) => {
  const localize = useLocalize();
  const file = attachment as TFile;
  const path = attachment.workspaceChange.path;
  const filename = path.split('/').pop() || path;
  const { handleDownload } = useAttachmentLink({
    href: attachment.filepath ?? '',
    filename,
    file_id: file.file_id,
    user: file.user,
    source: file.source,
  });

  return (
    <div className="bg-surface-secondary flex min-w-0 items-center gap-2 rounded-lg px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-text-primary truncate text-sm font-medium" title={filename}>
          {filename}
        </div>
        {path !== filename && (
          <div className="text-text-secondary truncate text-xs" title={path}>
            {path}
          </div>
        )}
      </div>
      <IconButton
        onClick={(event) => void handleDownload(event)}
        label={`${localize('com_ui_download')} ${filename}`}
        title={localize('com_ui_download')}
        variant="ghost"
        size="sm"
        shape="square"
        className="text-text-secondary"
      >
        <Download className="size-4" aria-hidden="true" />
      </IconButton>
    </div>
  );
});

WorkspaceChange.displayName = 'WorkspaceChange';

export default function WorkspaceChanges({
  attachments,
}: {
  attachments: StatefulWorkspaceAttachment[];
}) {
  const localize = useLocalize();
  const panelId = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  const { style, ref } = useExpandCollapse(isExpanded);
  const count = attachments.length;
  const countLabel = localize(count === 1 ? 'com_ui_one_file_changed' : 'com_ui_n_files_changed', {
    0: String(count),
  });
  const summary = useMemo(
    () => attachments.map((attachment) => attachment.workspaceChange.path).join(', '),
    [attachments],
  );

  if (count === 0) {
    return null;
  }

  return (
    <div className="my-2 max-w-xl">
      <Button
        variant="disclosure"
        aria-expanded={isExpanded}
        aria-controls={panelId}
        aria-label={`${localize('com_ui_workspace_changes')}: ${countLabel}`}
        onClick={() => setIsExpanded((previous) => !previous)}
        className="text-text-secondary h-auto max-w-full justify-start py-1 pr-2 pl-0 font-normal"
      >
        <Files className="size-4 shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium">{localize('com_ui_workspace_changes')}</span>
        <span className="min-w-0 truncate text-xs" title={summary}>
          {'— '}
          {countLabel}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 transition-transform duration-200 ease-out',
            isExpanded && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </Button>
      <div id={panelId} style={style} inert={!isExpanded ? '' : undefined}>
        <div className="overflow-hidden" ref={ref} aria-hidden={!isExpanded}>
          <div className="flex flex-col gap-2 pt-2">
            {attachments.map((attachment) => (
              <WorkspaceChange
                key={`${attachment.filepath}:${attachment.workspaceChange.path}`}
                attachment={attachment}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
