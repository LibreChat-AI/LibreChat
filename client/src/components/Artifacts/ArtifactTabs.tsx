import { lazy, Suspense, useRef } from 'react';
import { Spinner } from '@librechat/client';
import * as Tabs from '@radix-ui/react-tabs';
import type { SandpackPreviewRef } from '@codesandbox/sandpack-react/unstyled';
import type { editor } from 'monaco-editor';
import type { ProcessedMermaidSvg } from '~/utils/diagram/export';
import { MermaidRenderer } from '~/components/Messages/Content/Mermaid/Mermaid';
import { MERMAID_ARTIFACT_TYPE, type Artifact } from '~/common/artifacts';
import { ArtifactCodeEditor } from './ArtifactCodeEditor';
import { useCodeState } from '~/Providers/EditorContext';
import { useLocalize } from '~/hooks';

const SandboxArtifactTabs = lazy(() => import('./SandboxArtifactTabs'));

interface ArtifactTabsProps {
  artifact: Artifact;
  previewRef: React.MutableRefObject<SandpackPreviewRef>;
  isSharedConvo?: boolean;
  onMermaidExportReady?: (data: ProcessedMermaidSvg | null) => void;
}

function LoadingArtifactTabs() {
  const localize = useLocalize();

  return (
    <div
      className="bg-surface-primary text-text-secondary flex h-full w-full items-center justify-center"
      role="status"
    >
      <Spinner className="size-5" aria-hidden="true" />
      <span className="sr-only">{localize('com_ui_loading')}</span>
    </div>
  );
}

function MermaidArtifactTabs({
  artifact,
  isSharedConvo,
  onMermaidExportReady,
}: Omit<ArtifactTabsProps, 'previewRef'>) {
  const localize = useLocalize();
  const { currentCode, codeArtifactId } = useCodeState();
  const monacoRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  /* The buffer belongs to whichever artifact last wrote it: a freshly keyed
   * renderer must not show (or export) the diagram we navigated away from,
   * while a pane that remounted for another host keeps its unsaved text. */
  const hasCurrentArtifactCode = codeArtifactId === artifact.id;

  const content = (hasCurrentArtifactCode ? currentCode : undefined) ?? artifact.content ?? '';
  const isReadOnly = isSharedConvo === true || artifact.index == null;

  return (
    <div className="flex h-full w-full flex-col">
      <Tabs.Content
        value="code"
        id="artifacts-code"
        className="h-full w-full grow overflow-auto"
        tabIndex={-1}
      >
        <ArtifactCodeEditor artifact={artifact} monacoRef={monacoRef} readOnly={isReadOnly} />
      </Tabs.Content>

      <Tabs.Content
        value="preview"
        className="min-h-0 w-full flex-1 overflow-hidden p-4"
        tabIndex={-1}
      >
        {/* Keyed by artifact so switching between two diagrams cannot carry the
            previous render, its dimensions, or its export payload across the
            boundary while the new source debounces. */}
        <MermaidRenderer
          key={artifact.id}
          exportFilename={artifact.title ?? localize('com_ui_mermaid_diagram')}
          fillContainer
          onExportReady={onMermaidExportReady}
          showExpandButton={false}
          showHeader={false}
        >
          {content}
        </MermaidRenderer>
      </Tabs.Content>
    </div>
  );
}

export default function ArtifactTabs(props: ArtifactTabsProps) {
  if (props.artifact.type === MERMAID_ARTIFACT_TYPE) {
    return (
      <MermaidArtifactTabs
        artifact={props.artifact}
        isSharedConvo={props.isSharedConvo}
        onMermaidExportReady={props.onMermaidExportReady}
      />
    );
  }

  return (
    <Suspense fallback={<LoadingArtifactTabs />}>
      <SandboxArtifactTabs {...props} />
    </Suspense>
  );
}
