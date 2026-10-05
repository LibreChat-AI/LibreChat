import React, { memo, useMemo, type MutableRefObject } from 'react';
import { SandpackPreview, SandpackProvider } from '@codesandbox/sandpack-react/unstyled';
import type {
  SandpackProviderProps,
  SandpackPreviewRef,
} from '@codesandbox/sandpack-react/unstyled';
import type { SandpackStartupConfig } from '~/utils/artifacts';
import type { ArtifactFiles } from '~/common';
import { ARTIFACT_PREVIEW_BRIDGE_SCRIPT } from '~/utils/artifactPreviewCapture';
import { sharedFiles, buildSandpackOptions } from '~/utils/artifacts';

function getFileCode(file: unknown): string | undefined {
  if (typeof file === 'string') {
    return file;
  }
  if (file && typeof file === 'object' && 'code' in file && typeof file.code === 'string') {
    return file.code;
  }
  return undefined;
}

/**
 * Sandpack's `static` template serves the artifact's own `/index.html` directly — unlike
 * bundler-based templates, it never touches `sharedFiles['/public/index.html']` (a
 * create-react-app-style shell those templates load instead), so the preview-capture bridge
 * script has to be injected into this file specifically or capture silently times out.
 */
function injectPreviewBridge(html: string): string {
  const script = `<script>${ARTIFACT_PREVIEW_BRIDGE_SCRIPT}</script>`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${script}\n</head>`);
  }
  return `${script}\n${html}`;
}

export const ArtifactPreview = memo(function ({
  files,
  fileKey,
  template,
  sharedProps,
  previewRef,
  currentCode,
  startupConfig,
}: {
  files: ArtifactFiles;
  fileKey: string;
  template: SandpackProviderProps['template'];
  sharedProps: Partial<SandpackProviderProps>;
  previewRef: MutableRefObject<SandpackPreviewRef>;
  currentCode?: string;
  startupConfig?: SandpackStartupConfig;
}) {
  const artifactFiles = useMemo(() => {
    if (Object.keys(files).length === 0) {
      return files;
    }
    const code = currentCode ?? '';
    const base = !code
      ? files
      : {
          ...files,
          [fileKey]: { code },
        };
    if (template !== 'static') {
      return base;
    }
    const html = getFileCode(base['index.html']);
    return html ? { ...base, 'index.html': { code: injectPreviewBridge(html) } } : base;
  }, [currentCode, files, fileKey, template]);

  const options: SandpackProviderProps['options'] = useMemo(
    () => buildSandpackOptions(template, startupConfig),
    [startupConfig, template],
  );

  if (Object.keys(artifactFiles).length === 0) {
    return null;
  }

  return (
    <SandpackProvider
      files={{ ...artifactFiles, ...sharedFiles }}
      options={options}
      {...sharedProps}
      template={template}
    >
      <SandpackPreview
        showOpenInCodeSandbox={false}
        showRefreshButton={false}
        tabIndex={0}
        ref={previewRef}
      />
    </SandpackProvider>
  );
});
