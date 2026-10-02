import { Upload } from 'lucide-react';

export const dropzoneClassName =
  'group flex w-full flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-border-medium bg-surface-secondary px-4 py-7 text-sm font-medium text-text-secondary transition-colors hover:border-border-heavy hover:bg-surface-hover hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border-medium disabled:hover:bg-surface-secondary disabled:hover:text-text-secondary';

function DropzoneContent({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="pointer-events-none flex flex-col items-center justify-center gap-2 text-center">
      <span className="bg-surface-tertiary text-text-secondary group-hover:text-text-primary flex h-9 w-9 items-center justify-center rounded-full transition-colors">
        <Upload className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-text-primary text-sm font-medium">{label}</span>
        {hint ? (
          <span className="text-text-secondary group-hover:text-text-primary text-xs font-normal transition-colors">
            {hint}
          </span>
        ) : null}
      </span>
    </span>
  );
}

export default DropzoneContent;
