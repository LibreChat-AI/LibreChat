import { Spinner, FileIcon } from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import SourceIcon from './SourceIcon';
import { cn } from '~/utils';

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
}) => {
  return (
    <div className={cn('relative size-10 shrink-0 overflow-hidden rounded-xl', className)}>
      <FileIcon file={file} fileType={fileType} />
      <SourceIcon source={file?.source} isCodeFile={!!file?.['metadata']?.fileIdentifier} />
      {typeof file?.['progress'] === 'number' && file?.['progress'] < 1 && (
        <Spinner
          bgOpacity={0.2}
          color="white"
          className="absolute inset-0 m-2.5 flex items-center justify-center"
        />
      )}
    </div>
  );
};

export default FilePreview;
