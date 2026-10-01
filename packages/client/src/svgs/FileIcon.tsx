import { JSX } from 'react/jsx-runtime';
import type { TFile } from 'librechat-data-provider';

export default function FileIcon({
  file,
  fileType,
}: {
  file?: Partial<TFile> & { progress?: number };
  fileType: {
    fill: string;
    paths: React.FC;
    title: string;
  };
}): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 36 36"
      fill="none"
      className="h-10 w-10 shrink-0"
      width="36"
      height="36"
      aria-hidden="true"
    >
      <rect width="36" height="36" rx="6" fill={fileType.fill} />
      {(file?.['progress'] ?? 1) >= 1 && <>{<fileType.paths />}</>}
    </svg>
  );
}
