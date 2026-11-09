import type { TNmbFinding } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

/** Entity type, location and confidence for each finding. The value itself is never listed. */
export default function FindingsList({ findings }: { findings: TNmbFinding[] }) {
  const localize = useLocalize();
  if (findings.length === 0) {
    return <p className="text-text-secondary text-sm">{localize('com_nmb_no_findings')}</p>;
  }
  return (
    <ul className="divide-border-light border-border-light divide-y rounded-lg border text-sm">
      {findings.map((f, i) => (
        <li
          key={`${f.value_hash}-${i}`}
          className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
        >
          <span className="font-medium">{f.entity}</span>
          <span className="text-text-secondary">{f.action}</span>
          <span className="text-text-secondary">
            {localize('com_nmb_finding_location', {
              0: f.location.segment,
              1: String(f.location.start),
              2: String(f.location.end),
            })}
          </span>
          <span className="text-text-secondary ml-auto">
            {localize('com_nmb_finding_confidence', { 0: String(Math.round(f.score * 100)) })}
          </span>
        </li>
      ))}
    </ul>
  );
}
