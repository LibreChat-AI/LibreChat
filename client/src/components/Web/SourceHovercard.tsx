import React, { ReactNode } from 'react';
import * as Ariakit from '@ariakit/react';
import { Button } from '@librechat/client';
import { VisuallyHidden } from '@ariakit/react';
import { ChevronDown, FileText } from 'lucide-react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export interface SourceData {
  link: string;
  title?: string;
  attribution?: string;
  snippet?: string;
}

interface SourceHovercardProps {
  source: SourceData;
  label: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onClick?: (e: React.MouseEvent) => void;
  isFile?: boolean;
  isLocalFile?: boolean;
  children?: ReactNode;
  filePages?: number[];
  fileRelevance?: number;
}

function getFaviconUrl(domain: string) {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
}

export function getCleanDomain(url: string) {
  const domain = url.replace(/(^\w+:|^)\/\//, '').split('/')[0];
  return domain.startsWith('www.') ? domain.substring(4) : domain;
}

export function FaviconImage({ domain, className = '' }: { domain: string; className?: string }) {
  return (
    <img
      src={getFaviconUrl(domain)}
      alt={domain}
      className={cn('size-4 shrink-0 rounded-full', className)}
      loading="lazy"
    />
  );
}

const hovercardClass = cn(
  'z-[999] w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border border-border-medium bg-surface-secondary p-3 text-text-primary shadow-lg',
  'origin-top -translate-y-1 opacity-0 transition-[opacity,transform] duration-150 ease-out',
  'data-[enter]:translate-y-0 data-[enter]:opacity-100',
  'data-[leave]:-translate-y-1 data-[leave]:opacity-0',
);

function FileHovercardContent({
  source,
  onClick,
  filePages,
  fileRelevance,
}: {
  source: SourceData;
  onClick?: (e: React.MouseEvent) => void;
  filePages?: number[];
  fileRelevance?: number;
}) {
  const localize = useLocalize();
  const fileName = source.attribution || source.title || localize('com_file_source');

  return (
    <>
      <div className="flex items-center gap-2">
        <FileText className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
        <Button
          variant="link"
          onClick={onClick}
          className="text-text-primary h-auto min-w-0 justify-start truncate p-0 text-sm font-medium hover:underline"
        >
          {fileName}
        </Button>
      </div>
      {(fileRelevance != null || (filePages && filePages.length > 0)) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {fileRelevance != null && fileRelevance > 0 && (
            <span className="text-text-secondary text-xs">
              {localize('com_ui_relevance')}: {Math.round(fileRelevance * 100)}%
            </span>
          )}
          {filePages && filePages.length > 0 && (
            <span className="text-text-secondary text-xs">
              {localize('com_file_pages', { pages: filePages.join(', ') })}
            </span>
          )}
        </div>
      )}
      {source.snippet && (
        <p className="text-text-secondary mt-1.5 line-clamp-3 text-xs leading-relaxed break-words">
          {source.snippet}
        </p>
      )}
    </>
  );
}

export function SourceHovercard({
  source,
  label,
  onMouseEnter,
  onMouseLeave,
  onClick,
  isFile = false,
  isLocalFile = false,
  children,
  filePages,
  fileRelevance,
}: SourceHovercardProps) {
  const localize = useLocalize();
  const domain = getCleanDomain(source.link || '');
  const hovercard = Ariakit.useHovercardStore({ showTimeout: 150, hideTimeout: 150 });

  const handleFileClick = React.useCallback(
    (e: React.MouseEvent) => {
      hovercard.hide();
      onClick?.(e);
    },
    [hovercard, onClick],
  );

  return (
    <span className="relative ml-0.5 inline-block">
      <Ariakit.HovercardProvider store={hovercard}>
        <span className="flex items-center">
          <Ariakit.HovercardAnchor
            render={
              isFile ? (
                <button
                  onClick={handleFileClick}
                  className="border-border-heavy bg-surface-secondary text-text-primary hover:bg-surface-hover ml-1 inline-flex h-5 max-w-36 items-center gap-1 overflow-hidden rounded-xl border px-2 text-xs font-medium text-ellipsis whitespace-nowrap no-underline transition-colors"
                  onMouseEnter={onMouseEnter}
                  onMouseLeave={onMouseLeave}
                  title={
                    isLocalFile ? localize('com_sources_download_local_unavailable') : undefined
                  }
                >
                  <FileText className="text-text-secondary size-2.5 shrink-0" aria-hidden="true" />
                  {label}
                </button>
              ) : (
                <a
                  href={source.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="border-border-heavy bg-surface-secondary hover:bg-surface-hover ml-1 inline-block h-5 max-w-36 cursor-pointer items-center overflow-hidden rounded-xl border px-2 text-xs font-medium text-ellipsis whitespace-nowrap no-underline transition-colors"
                  onMouseEnter={onMouseEnter}
                  onMouseLeave={onMouseLeave}
                >
                  {label}
                </a>
              )
            }
          />
          <Ariakit.HovercardDisclosure className="text-text-primary focus:ring-text-primary ml-0.5 rounded-full focus:ring-2 focus:outline-hidden">
            <VisuallyHidden>{localize('com_citation_more_details', { label })}</VisuallyHidden>
            <ChevronDown className="icon-sm" aria-hidden="true" />
          </Ariakit.HovercardDisclosure>

          <Ariakit.Hovercard
            gutter={16}
            className={hovercardClass}
            portal={true}
            unmountOnHide={true}
          >
            <div>
              {children ??
                (isFile ? (
                  <FileHovercardContent
                    source={source}
                    onClick={handleFileClick}
                    filePages={filePages}
                    fileRelevance={fileRelevance}
                  />
                ) : (
                  <>
                    <div className="mb-1.5 overflow-hidden text-sm">
                      <FaviconImage domain={domain} className="float-left mt-0.5 mr-2" />
                      <span className="text-text-secondary float-right ml-2 max-w-[40%] truncate text-xs">
                        {domain}
                      </span>
                      <a
                        href={source.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-text-primary font-medium hover:underline"
                      >
                        {source.title || source.link}
                      </a>
                    </div>
                    {source.snippet && (
                      <p className="text-text-secondary line-clamp-4 text-xs break-words md:text-sm">
                        {source.snippet}
                      </p>
                    )}
                  </>
                ))}
            </div>
          </Ariakit.Hovercard>
        </span>
      </Ariakit.HovercardProvider>
    </span>
  );
}
