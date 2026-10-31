import { memo } from 'react';

function SectionHeader({ title, info }: { title: string; info: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-text-primary text-sm font-semibold">{title}</h3>
      <p className="text-text-secondary mt-1 text-sm leading-relaxed">{info}</p>
      <div className="bg-border-light mt-3 h-px w-full" aria-hidden="true" />
    </div>
  );
}

export default memo(SectionHeader);
