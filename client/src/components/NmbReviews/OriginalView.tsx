import type { TNmbFinding, TNmbOriginal } from 'librechat-data-provider';
import { splitSegment, maskPreview } from '~/components/Nmb/highlight';
import { useLocalize } from '~/hooks';

/** The original with findings highlighted, next to the masked preview. Reviewers only. */
export default function OriginalView({
  original,
  findings,
}: {
  original: TNmbOriginal;
  findings: TNmbFinding[];
}) {
  const localize = useLocalize();
  return (
    <div className="flex flex-col gap-4">
      {original.segments.map((segment) => (
        <div key={segment.location} className="grid gap-3 md:grid-cols-2">
          <section aria-label={localize('com_nmb_original')}>
            <h4 className="text-text-secondary mb-1 text-xs font-medium uppercase">
              {localize('com_nmb_original')} · {segment.location}
            </h4>
            <pre className="border-border-light bg-surface-secondary max-h-80 overflow-auto rounded-lg border p-3 text-sm whitespace-pre-wrap">
              {splitSegment(segment.text, findings, segment.location).map((piece, i) =>
                piece.finding ? (
                  <mark
                    key={i}
                    className="bg-surface-destructive text-text-primary rounded px-0.5"
                    title={piece.finding.entity}
                  >
                    {piece.text}
                  </mark>
                ) : (
                  <span key={i}>{piece.text}</span>
                ),
              )}
            </pre>
          </section>
          <section aria-label={localize('com_nmb_masked_preview')}>
            <h4 className="text-text-secondary mb-1 text-xs font-medium uppercase">
              {localize('com_nmb_masked_preview')}
            </h4>
            <pre className="border-border-light bg-surface-secondary max-h-80 overflow-auto rounded-lg border p-3 text-sm whitespace-pre-wrap">
              {maskPreview(segment.text, findings, segment.location)}
            </pre>
          </section>
        </div>
      ))}
    </div>
  );
}
