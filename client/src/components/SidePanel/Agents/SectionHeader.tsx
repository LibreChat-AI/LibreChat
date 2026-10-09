import { memo } from 'react';

function SectionHeader({ title, info }: { title: string; info: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-text-secondary">{info}</p>
      <div className="mt-3 h-px w-full bg-border-light" aria-hidden="true" />
    </div>
  );
}

export default memo(SectionHeader);
