import { cn } from '@librechat/client';
import { Terminal, Type, Database } from 'lucide-react';
import { EModelEndpoint, FileSources } from 'librechat-data-provider';
import { useFilesHost } from '../../../react/files';

/** Built per render rather than at import, so loading the components entry reads no
 *  `librechat-data-provider` enums; specs that replace that module can still import it. */
const sourceToEndpoint = (): Partial<Record<string, EModelEndpoint>> => ({
  [FileSources.openai]: EModelEndpoint.openAI,
  [FileSources.azure]: EModelEndpoint.azureOpenAI,
});

const sourceToClassname = (): Partial<Record<string, string>> => ({
  [FileSources.openai]: 'bg-white/75 dark:bg-black/65',
  [FileSources.azure]: 'azure-bg-color',
  [FileSources.azure_blob]: 'azure-bg-color',
  [FileSources.execute_code]: 'bg-surface-media-overlay text-text-on-media opacity-85',
  /** Categorical rather than status: a source is an identity, so it takes a
   *  series slot and the label ink that pairs with one. No alpha here, which
   *  composited the fill back into the preview the badge sits on. */
  [FileSources.text]: 'bg-series-1 text-text-on-status',
  [FileSources.vectordb]: 'bg-series-4 text-text-on-status',
});

const defaultClassName =
  'absolute inset-e-0 bottom-0 rounded-full p-[0.15rem] text-text-secondary transition-colors';

export default function SourceIcon({
  source,
  isCodeFile,
  className = defaultClassName,
}: {
  source?: FileSources;
  isCodeFile?: boolean;
  className?: string;
}): React.JSX.Element | null {
  const { renderEndpointIcon } = useFilesHost();
  if (isCodeFile === true) {
    return (
      <div className={cn(className, sourceToClassname()[FileSources.execute_code] ?? '')}>
        <span className="flex items-center justify-center">
          <Terminal className="h-3 w-3" aria-hidden="true" />
        </span>
      </div>
    );
  }

  if (source === FileSources.text) {
    return (
      <div className={cn(className, sourceToClassname()[source] ?? '')}>
        <span className="flex items-center justify-center">
          <Type className="h-3 w-3" aria-hidden="true" />
        </span>
      </div>
    );
  }

  if (source === FileSources.vectordb) {
    return (
      <div className={cn(className, sourceToClassname()[source] ?? '')}>
        <span className="flex items-center justify-center">
          <Database className="h-3 w-3" aria-hidden="true" />
        </span>
      </div>
    );
  }

  const endpoint = sourceToEndpoint()[source ?? ''];

  if (!endpoint) {
    return null;
  }
  return (
    <div className={cn(className, sourceToClassname()[source ?? ''] ?? '')}>
      <span className="flex items-center justify-center">{renderEndpointIcon(endpoint)}</span>
    </div>
  );
}
