import { forwardRef } from 'react';
import { Button } from '@librechat/client';
import {
  AppWindow,
  Download,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Presentation,
  Workflow,
} from 'lucide-react';
import type { ArtifactGlyph, ArtifactRowKind } from '~/utils/artifacts';
import LangIcon, { hasLangIcon } from '~/components/Messages/Content/LangIcon';
import { ROW_GLYPH_SLOT, TOOL_ROW_CLASSES } from '../rows';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const FALLBACK_GLYPHS: Record<ArtifactGlyph, React.ComponentType<{ className?: string }>> = {
  preview: AppWindow,
  code: FileCode2,
  text: FileText,
  diagram: Workflow,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
};

interface ArtifactRowProps {
  /** Filename for file-backed artifacts, authored title for markdown ones. */
  title: string;
  kind: ArtifactRowKind;
  /** This artifact is the one the panel is currently showing. */
  isSelected: boolean;
  onOpen: () => void;
  /**
   * Omitted when no real file backs the artifact (model-authored
   * content). Takes the event because `useAttachmentLink`'s handler
   * needs it to suppress the anchor default.
   */
  onDownload?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Stable trigger id, for the panel's focus handoff and for e2e. */
  artifactId?: string;
}

/**
 * The single chat-side trigger for every artifact: code-execution output,
 * a model-authored `:::artifact` block, and a mermaid diagram all render
 * through here.
 *
 * It is a tool row, not a card. Artifacts arrive interleaved with the
 * rows that produced them, and the previous three-card-variant chip
 * layout broke that column: a wrapped strip of fixed-width chips at a
 * fourth indentation, so a message that wrote five files read as five
 * unrelated buttons rather than five steps. `TOOL_ROW_CLASSES` plus
 * `ROW_GLYPH_SLOT` put the glyph on the message header's avatar axis and
 * the title where every other row's text starts.
 *
 * The file type is carried twice, because neither signal alone is enough:
 * the glyph is the language's own brand mark where one exists (an `.html`
 * artifact is not a `.py` artifact), and the format badge names the
 * format for titles that aren't filenames. `kind.rendersPreview` tints
 * the glyph with the `status-info` accent the mermaid trigger already
 * used — the row says whether opening this yields something to look at
 * or source to read, which is what the panel does differently.
 */
const ArtifactRow = forwardRef<HTMLButtonElement, ArtifactRowProps>(function ArtifactRow(
  { title, kind, isSelected, onOpen, onDownload, artifactId },
  ref,
) {
  const localize = useLocalize();
  const actionLabel = isSelected
    ? localize('com_ui_click_to_close')
    : localize('com_ui_artifact_click');
  const label = 'key' in kind.label ? localize(kind.label.key) : kind.label.text;
  const Fallback = FALLBACK_GLYPHS[kind.fallbackGlyph];
  let glyph = <Fallback className="size-4 shrink-0" />;
  if (kind.lang !== '' && hasLangIcon(kind.lang)) {
    glyph = <LangIcon lang={kind.lang} className="size-4 shrink-0" />;
  }

  return (
    <div className={cn(TOOL_ROW_CLASSES, 'text-sm text-text-secondary')}>
      <Button
        ref={ref}
        type="button"
        variant="ghost"
        aria-controls="artifact-viewer"
        aria-expanded={isSelected}
        data-artifact-trigger={artifactId}
        onClick={onOpen}
        className={cn(
          'inline-flex h-auto min-w-0 flex-1 items-center justify-start gap-2.5 rounded-none p-0',
          'hover:bg-transparent hover:text-text-primary focus-visible:ring-text-primary focus-visible:ring-offset-0',
          isSelected && 'text-text-primary',
        )}
      >
        <span
          className={cn(ROW_GLYPH_SLOT, kind.rendersPreview && 'text-status-info')}
          aria-hidden="true"
        >
          {glyph}
        </span>
        <span className="min-w-0 truncate font-medium" title={title}>
          {title}
        </span>
        {/* No vertical padding: `TOOL_ROW_CLASSES` fixes the row at 20px so
            the streaming cursor and a call header can trade places without
            moving what is under them, and a taller child here would push
            past that box. */}
        <span className="shrink-0 rounded px-1.5 text-[10px] font-medium uppercase leading-5 tracking-wide text-text-tertiary ring-1 ring-inset ring-border-light">
          {label}
        </span>
        {/* The glyph's tint is the visual half of the preview/source split
            and reaches nobody using a screen reader, so the same fact is
            folded into the button's accessible name. */}
        <span className="sr-only">
          {`${
            kind.rendersPreview
              ? localize('com_ui_artifact_renders')
              : localize('com_ui_artifact_source')
          } ${actionLabel}`}
        </span>
      </Button>
      {onDownload != null && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onDownload}
          aria-label={`${localize('com_ui_download')} ${title}`}
          className="size-5 shrink-0 rounded text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-text-primary focus-visible:ring-offset-0"
        >
          <Download className="size-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
});

export default ArtifactRow;
