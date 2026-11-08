import React, { memo, useMemo, type MutableRefObject } from 'react';
import { SandpackPreview, SandpackProvider } from '@codesandbox/sandpack-react/unstyled';
import type {
  SandpackProviderProps,
  SandpackPreviewRef,
} from '@codesandbox/sandpack-react/unstyled';
import type { SandpackStartupConfig } from '~/utils/artifacts';
import type { ArtifactFiles } from '~/common';
import {
  sharedFiles,
  buildSandpackOptions,
  scopeHtmlScripts,
  isHtmlFilename,
} from '~/utils/artifacts';

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
    if (!code) {
      return files;
    }
    return {
      ...files,
      [fileKey]: { code },
    };
  }, [currentCode, files, fileKey]);

  /* Scope inline classic scripts in HTML files on static templates so top-level
   * `let`/`const`/`class` names do not collide with Sandpack's injected console hook (#17860). */
  const sandpackFiles = useMemo(() => {
    if (template !== 'static' || Object.keys(artifactFiles).length === 0) {
      return artifactFiles;
    }

    const scoped: Record<string, string | { code: string }> = {};
    for (const [key, val] of Object.entries(artifactFiles)) {
      if (!isHtmlFilename(key)) {
        scoped[key] = val as string | { code: string };
        continue;
      }

      if (typeof val === 'string') {
        scoped[key] = scopeHtmlScripts(val);
      } else if (val && typeof val === 'object' && 'code' in val && typeof val.code === 'string') {
        scoped[key] = {
          ...val,
          code: scopeHtmlScripts(val.code),
        };
      } else {
        scoped[key] = val as string | { code: string };
      }
    }
    return scoped;
  }, [artifactFiles, template]);

  const options: SandpackProviderProps['options'] = useMemo(
    () => buildSandpackOptions(template, startupConfig),
    [startupConfig, template],
  );

  if (Object.keys(artifactFiles).length === 0) {
    return null;
  }

  return (
    <SandpackProvider
      files={{ ...sandpackFiles, ...sharedFiles }}
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
