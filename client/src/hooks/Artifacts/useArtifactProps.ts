import { useContext, useMemo } from 'react';
import { ThemeContext } from '@librechat/client';
import { removeNullishValues } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import {
  getKey,
  getProps,
  getTemplate,
  getArtifactFilename,
  getSvgFiles,
  isSvgArtifactType,
  languageForFilename,
  wrapAsFencedCodeBlock,
  TOOL_ARTIFACT_TYPES,
} from '~/utils/artifacts';
import { withOfficeContrast } from '~/utils/officePreview';
import { getMarkdownFiles } from '~/utils/markdown';
import { getMermaidFiles } from '~/utils/mermaid';

export default function useArtifactProps({ artifact }: { artifact: Artifact }) {
  const { resolvedMode, highContrast } = useContext(ThemeContext);
  const isDarkMode = resolvedMode === 'dark';

  const [fileKey, files] = useMemo(() => {
    const key = getKey(artifact.type ?? '', artifact.language);
    const type = artifact.type ?? '';

    if (key.includes('mermaid')) {
      return ['diagram.mmd', getMermaidFiles(artifact.content ?? '', isDarkMode, highContrast)];
    }

    /* CODE bucket: source files render through the same static-markdown
     * pipeline as .md artifacts, but the raw source is wrapped in a
     * fenced code block first so `marked` outputs
     * `<pre><code class="language-<lang>">…</code></pre>` instead of
     * paragraph text. The language hint is computed once at artifact
     * construction (`fileToArtifact` writes it to `artifact.language`)
     * so the MIME fallback fires for extensionless-filename + useful-
     * MIME inputs. Title-derived fallback covers older callers that
     * didn't set `language`. */
    if (type === TOOL_ARTIFACT_TYPES.CODE) {
      const lang = artifact.language ?? languageForFilename(artifact.title);
      const wrapped = wrapAsFencedCodeBlock(artifact.content ?? '', lang);
      return ['content.md', getMarkdownFiles(wrapped, isDarkMode, highContrast)];
    }

    if (type === 'text/markdown' || type === 'text/md' || type === 'text/plain') {
      return ['content.md', getMarkdownFiles(artifact.content ?? '', isDarkMode, highContrast)];
    }

    /* Office preview buckets (DOCX/SPREADSHEET/PRESENTATION): the backend
     * already produced a complete sanitized HTML document via
     * `bufferToOfficeHtml` and shipped it as `attachment.text`. Hand it
     * to the Sandpack `static` template's `index.html` slot directly —
     * no wrapping, no transformation, no client-side parsing libs. The
     * contrast override is injected client-side because the document is
     * generated server-side with no knowledge of the viewer's appearance
     * mode. The empty-text gate in `detectArtifactTypeFromFile` guarantees we
     * never reach this branch with an empty content payload. */
    if (
      type === TOOL_ARTIFACT_TYPES.DOCX ||
      type === TOOL_ARTIFACT_TYPES.SPREADSHEET ||
      type === TOOL_ARTIFACT_TYPES.PRESENTATION
    ) {
      const content = artifact.content ?? '';
      return [
        'index.html',
        { 'index.html': highContrast ? withOfficeContrast(content, isDarkMode) : content },
      ];
    }

    if (isSvgArtifactType(type)) {
      return [getArtifactFilename(type), getSvgFiles(artifact.content ?? '')];
    }

    const fileKey = getArtifactFilename(artifact.type ?? '', artifact.language);
    const files = removeNullishValues({
      [fileKey]: artifact.content,
    });
    return [fileKey, files];
  }, [
    artifact.type,
    artifact.content,
    artifact.language,
    artifact.title,
    isDarkMode,
    highContrast,
  ]);

  const template = useMemo(
    () => getTemplate(artifact.type ?? '', artifact.language),
    [artifact.type, artifact.language],
  );

  const sharedProps = useMemo(() => getProps(artifact.type ?? ''), [artifact.type]);

  /* SVG previews render a *derived* `index.html`, not the edited file itself,
   * so swapping `fileKey` alone would leave the preview on the original
   * source while the code tab shows the new one. Consumers that hold editor
   * text rebuild the whole set through this instead. */
  const deriveFiles = useMemo(
    () => (isSvgArtifactType(artifact.type ?? '') ? getSvgFiles : undefined),
    [artifact.type],
  );

  return {
    files,
    fileKey,
    template,
    sharedProps,
    deriveFiles,
  };
}
