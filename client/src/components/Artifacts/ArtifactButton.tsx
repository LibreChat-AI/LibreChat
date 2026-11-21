import { memo, useEffect, useMemo } from 'react';
import { selectAtom } from 'jotai/utils';
import { Button } from '@librechat/client';
import { useAtomValue, useSetAtom } from 'jotai';
import { LangIcon, hasLangIcon } from '@librechat/chat/components';
import { ArrowUpRight, CircleAlert, FileCode2, LoaderCircle } from 'lucide-react';
import type { Artifact } from '~/common';
import { useOptionalMessagesOperations } from '~/Providers/MessagesViewContext';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import { artifactRowKind } from '~/utils/artifacts';
import { useMessageContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import store from '~/store';

interface ArtifactButtonProps {
  artifact: Artifact | null;
  identifier?: string;
  title?: string;
  type: string;
  streaming: boolean;
  canOpen: boolean;
}

const ArtifactButton = memo(function ArtifactButton({
  artifact,
  identifier,
  title,
  type,
  streaming,
  canOpen,
}: ArtifactButtonProps) {
  const localize = useLocalize();
  const { messageId, conversationId } = useMessageContext();
  const { getMessages } = useOptionalMessagesOperations();
  const { currentArtifactId, registered, register, open, close } =
    useMessagePartsHost().useArtifactPanel(artifact?.id ?? '');
  const needsPrevious = artifact == null && canOpen && Boolean(identifier);
  const ancestors = useMemo(() => {
    if (!needsPrevious || conversationId == null) {
      return null;
    }
    const messages = getMessages(conversationId);
    if (messages == null) {
      return null;
    }
    // Cache order can include siblings and is unrelated to when their rows mounted.
    const parents = new Map(
      messages.map((message) => [message.messageId, message.parentMessageId]),
    );
    const ordered = new Map<string, number>();
    let parent = parents.get(messageId);
    while (parent != null && parents.has(parent) && parent !== messageId && !ordered.has(parent)) {
      ordered.set(parent, ordered.size);
      parent = parents.get(parent);
    }
    return ordered;
  }, [needsPrevious, getMessages, conversationId, messageId]);

  const artifactId = artifact?.id;
  const archiveEntry = useAtomValue(
    useMemo(
      () =>
        selectAtom(store.visibleArtifacts, (archive) => {
          if (artifactId != null) {
            return archive?.[artifactId] ?? null;
          }
          if (ancestors == null || archive == null) {
            return null;
          }
          let best: Artifact | null = null;
          let bestDistance = Infinity;
          for (const candidate of Object.values(archive)) {
            if (candidate?.messageId == null || candidate.identifier !== identifier) {
              continue;
            }
            const distance = ancestors.get(candidate.messageId);
            if (
              distance != null &&
              (distance < bestDistance ||
                (distance === bestDistance && (candidate.index ?? -1) > (best?.index ?? -1)))
            ) {
              best = candidate;
              bestDistance = distance;
            }
          }
          return best;
        }),
      [ancestors, artifactId, identifier],
    ),
  );
  const setArchive = useSetAtom(store.visibleArtifacts);
  useEffect(() => {
    if (artifact == null || !canOpen) {
      return;
    }
    register(artifact);
    setArchive((previous) => ({ ...previous, [artifact.id]: artifact }));
  }, [artifact, canOpen, register, setArchive]);

  useEffect(() => {
    if (artifact == null || !canOpen) {
      return;
    }
    // A warm route may mount rows before the conversation reset runs.
    if (archiveEntry == null) {
      setArchive((previous) =>
        previous?.[artifact.id] == null ? { ...previous, [artifact.id]: artifact } : previous,
      );
    }
    if (registered == null && archiveEntry === artifact) {
      register(artifact);
    }
  }, [archiveEntry, artifact, canOpen, register, registered, setArchive]);

  const previous = artifact == null ? archiveEntry : null;
  const target = artifact ?? previous;
  const isSelected = target != null && target.id === currentArtifactId;
  const kind = artifactRowKind({ type, title });
  const format = 'key' in kind.label ? localize(kind.label.key) : kind.label.text;
  const displayTitle = title ?? localize('com_ui_untitled');
  let status = localize('com_ui_artifact_ready');
  let indicator: React.ReactNode = null;
  if (artifact == null) {
    if (streaming) {
      status = localize(previous != null ? 'com_ui_artifact_updating' : 'com_ui_artifact_creating');
      indicator = (
        <LoaderCircle className="size-3 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
      );
    } else {
      status = localize('com_ui_artifact_stopped');
      indicator = <CircleAlert className="size-3 shrink-0" aria-hidden="true" />;
    }
  }
  const openAction = artifact == null ? 'com_ui_artifact_open_previous' : 'com_ui_artifact_open';
  const action = localize(isSelected ? 'com_ui_artifact_close' : openAction);

  return (
    <div
      data-testid="authored-artifact-card"
      className="border-border-light bg-surface-secondary text-text-primary my-2 flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3"
    >
      <div className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
        <div
          className="bg-surface-primary text-status-info flex size-8 shrink-0 items-center justify-center rounded-md"
          aria-hidden="true"
        >
          {kind.lang !== '' && hasLangIcon(kind.lang) ? (
            <LangIcon lang={kind.lang} className="size-4" />
          ) : (
            <FileCode2 className="size-4" />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium" title={displayTitle}>
              {displayTitle}
            </span>
            <span className="text-text-tertiary ring-border-light text-3xs shrink-0 rounded px-1.5 leading-5 font-medium tracking-wide uppercase ring-1 ring-inset">
              {format}
            </span>
          </div>
          <div className="text-text-secondary flex items-center gap-1.5 text-xs" role="status">
            {indicator}
            {status}
          </div>
        </div>
      </div>
      {canOpen && target != null && (
        <Button
          type="button"
          variant={artifact != null && !isSelected ? 'default' : 'outline'}
          size="xs"
          className="ms-auto"
          aria-controls="artifact-viewer"
          aria-expanded={isSelected}
          aria-label={`${action}: ${target.title ?? displayTitle}. ${localize(
            artifactRowKind(target).rendersPreview
              ? 'com_ui_artifact_renders'
              : 'com_ui_artifact_source',
          )}`}
          data-artifact-trigger={artifact?.id}
          onClick={() => {
            if (isSelected) {
              close();
              return;
            }
            register(target);
            open(target.id);
          }}
        >
          {action}
          {!isSelected && <ArrowUpRight className="size-3 rtl:-scale-x-100" aria-hidden="true" />}
        </Button>
      )}
    </div>
  );
});

export default ArtifactButton;
