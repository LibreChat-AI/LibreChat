import { cn, Spinner, FileIcon } from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import type { ExtendedFile } from '../../../core/files';
import SourceIcon from './SourceIcon';

const FilePreview = ({
  file,
  fileType,
  className = '',
}: {
  file?: Partial<ExtendedFile | TFile>;
  fileType: {
    paths: React.FC;
    fillClassName: string;
    title: string;
  };
  className?: string;
}): React.JSX.Element => {
  const progress = file != null && 'progress' in file ? file.progress : undefined;
  return (
    <div className={cn('relative size-10 shrink-0 overflow-hidden rounded-xl', className)}>
      <FileIcon file={file} fileType={fileType} />
      <SourceIcon source={file?.source} isCodeFile={!!file?.['metadata']?.fileIdentifier} />
      {typeof progress === 'number' && progress < 1 && (
        /* The spinner strokes in currentColor, so it takes the glyph's ink: white on the stock
         * tiles, black on the light high-contrast dark tiles. */
        <span className="text-file-ink absolute inset-0 m-2.5 flex items-center justify-center">
          <Spinner bgOpacity={0.2} />
        </span>
      )}
    </div>
  );
};

export default FilePreview;
