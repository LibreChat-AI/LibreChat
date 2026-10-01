import { useEffect, useMemo, useRef } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import type { SandpackPreviewRef } from '@codesandbox/sandpack-react/unstyled';
import type { editor } from 'monaco-editor';
import type { Artifact } from '~/common';
import { useGetSharedStartupConfig, useGetStartupConfig } from '~/data-provider';
import useArtifactProps from '~/hooks/Artifacts/useArtifactProps';
import { ArtifactCodeEditor } from './ArtifactCodeEditor';
import { useCodeState } from '~/Providers/EditorContext';
import { ArtifactPreview } from './ArtifactPreview';
import { useShareContext } from '~/Providers';

export default function SandboxArtifactTabs({
  artifact,
  previewRef,
  isSharedConvo,
}: {
  artifact: Artifact;
  previewRef: React.MutableRefObject<SandpackPreviewRef>;
  isSharedConvo?: boolean;
}) {
  const { currentCode, setCurrentCode } = useCodeState();
  const { shareId } = useShareContext();
  const shouldUseSharedConfig =
    isSharedConvo === true && typeof shareId === 'string' && shareId.length > 0;
  const { data: startupConfig } = useGetStartupConfig({ enabled: !shouldUseSharedConfig });
  const { data: sharedStartupConfig } = useGetSharedStartupConfig(shareId, {
    enabled: shouldUseSharedConfig,
  });
  const resolvedStartupConfig = shouldUseSharedConfig ? sharedStartupConfig : startupConfig;
  const monacoRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const lastIdRef = useRef<string | null>(null);

  /* The reset lands only after commit, so the render that switches artifacts
   * still sees the previous artifact's editor text. */
  const hasCurrentArtifactCode = lastIdRef.current === artifact.id;

  useEffect(() => {
    if (artifact.id !== lastIdRef.current) {
      setCurrentCode(undefined);
    }
    lastIdRef.current = artifact.id;
  }, [artifact.id, setCurrentCode]);

  const { files, fileKey, template, sharedProps, deriveFiles } = useArtifactProps({ artifact });
  const editedCode = hasCurrentArtifactCode ? currentCode : undefined;

  /* An artifact whose preview entry is derived from its source needs the whole
   * set rebuilt from the editor text; `ArtifactPreview` can only swap the file
   * the editor owns. Empty text counts as no edit there, so it does here too. */
  const previewFiles = useMemo(
    () => (deriveFiles != null && editedCode ? deriveFiles(editedCode) : files),
    [deriveFiles, editedCode, files],
  );

  return (
    <div className="flex h-full w-full flex-col">
      <Tabs.Content
        value="code"
        id="artifacts-code"
        className="h-full w-full grow overflow-auto"
        tabIndex={-1}
      >
        <ArtifactCodeEditor
          artifact={artifact}
          monacoRef={monacoRef}
          readOnly={isSharedConvo === true}
        />
      </Tabs.Content>

      <Tabs.Content value="preview" className="h-full w-full grow overflow-hidden" tabIndex={-1}>
        <ArtifactPreview
          files={previewFiles}
          fileKey={fileKey}
          template={template}
          previewRef={previewRef}
          sharedProps={sharedProps}
          currentCode={editedCode}
          startupConfig={resolvedStartupConfig}
        />
      </Tabs.Content>
    </div>
  );
}
