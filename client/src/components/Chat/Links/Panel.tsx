import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { AnimatedTabs, Button, Spinner } from '@librechat/client';
import { File, Globe, Image as ImageIcon, Newspaper, X } from 'lucide-react';
import type { ImageResult, ValidSource } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { SessionFileSource } from './aggregate';
import {
  aggregateSessionSources,
  countSessionSources,
  liveAttachmentsForConversation,
} from './aggregate';
import { FaviconImage, getCleanDomain } from '~/components/Web/SourceHovercard';
import { messageAttachmentsMapAtom } from '~/hooks/SSE/atoms';
import { useGetMessagesByConvoId } from '~/data-provider';
import { useLocalize } from '~/hooks';

function LinkRow({ source }: { source: ValidSource }) {
  const domain = getCleanDomain(source.link);
  return (
    <a
      href={source.link}
      target="_blank"
      rel="noopener noreferrer"
      className="bg-surface-primary-contrast hover:bg-surface-tertiary flex w-full flex-col rounded-lg px-3 py-2 text-sm transition-colors"
    >
      <div className="flex items-center gap-2">
        <FaviconImage domain={domain} />
        <span className="text-text-secondary truncate text-xs font-medium">{domain}</span>
      </div>
      <span className="text-text-primary mt-1 line-clamp-2 text-sm font-medium">
        {source.title || source.link}
      </span>
      {'snippet' in source && source.snippet && (
        <span className="text-text-secondary mt-1 line-clamp-2 text-xs">{source.snippet}</span>
      )}
    </a>
  );
}

function ImageTile({ image, label }: { image: ImageResult; label: string }) {
  return (
    <a
      href={image.imageUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="bg-surface-secondary hover:bg-surface-tertiary overflow-hidden rounded-lg transition-colors"
    >
      <div className="relative aspect-square w-full overflow-hidden">
        <img
          src={image.imageUrl}
          alt={image.title || label}
          className="size-full object-cover"
          loading="lazy"
        />
        {image.title && (
          <div className="bg-surface-media-overlay/80 text-text-on-media absolute inset-x-0 bottom-0 w-full p-1 text-xs font-medium backdrop-blur-xs">
            <span className="truncate">{image.title}</span>
          </div>
        )}
      </div>
    </a>
  );
}

function FileRow({ file, pagesLabel }: { file: SessionFileSource; pagesLabel: string }) {
  return (
    <div className="bg-surface-primary-contrast flex w-full flex-col rounded-lg px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <File className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
        <span className="text-text-primary line-clamp-2 text-sm font-medium">{file.filename}</span>
      </div>
      {file.pages && file.pages.length > 0 && (
        <span className="text-text-secondary mt-1 line-clamp-1 ps-6 text-xs">
          {pagesLabel}: {file.pages.join(', ')}
        </span>
      )}
      {file.bytes != null && file.bytes > 0 && (
        <span className="text-text-secondary mt-1 ps-6 text-xs">
          {(file.bytes / 1024).toFixed(1)} KB
        </span>
      )}
    </div>
  );
}

function TabLabel({ icon, label }: { icon: ReactElement; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {icon}
      {label}
    </span>
  );
}

export default function LinksPanel({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const localize = useLocalize();
  const { data: messages, isLoading } = useGetMessagesByConvoId(conversationId);
  const liveAttachmentsMap = useAtomValue(messageAttachmentsMapAtom);

  const sources = useMemo(
    () =>
      aggregateSessionSources(
        messages ?? [],
        liveAttachmentsForConversation(liveAttachmentsMap, conversationId),
      ),
    [messages, liveAttachmentsMap, conversationId],
  );

  const count = countSessionSources(sources);
  const imageAltLabel = localize('com_sources_image_alt');
  const pagesLabel = localize('com_sources_pages');

  const tabs = useMemo(() => {
    const availableTabs: Array<{ id: string; label: ReactElement; content: ReactElement }> = [];
    if (sources.links.length > 0 || sources.news.length > 0) {
      availableTabs.push({
        id: 'all',
        label: (
          <TabLabel
            icon={<Globe className="size-3.5" aria-hidden="true" />}
            label={localize('com_sources_tab_all')}
          />
        ),
        content: (
          <div className="flex flex-col gap-2">
            {[...sources.links, ...sources.news].map((source) => (
              <LinkRow key={source.link} source={source} />
            ))}
          </div>
        ),
      });
    }
    if (sources.news.length > 0) {
      availableTabs.push({
        id: 'news',
        label: (
          <TabLabel
            icon={<Newspaper className="size-3.5" aria-hidden="true" />}
            label={localize('com_sources_tab_news')}
          />
        ),
        content: (
          <div className="flex flex-col gap-2">
            {sources.news.map((source) => (
              <LinkRow key={source.link} source={source} />
            ))}
          </div>
        ),
      });
    }
    if (sources.images.length > 0) {
      availableTabs.push({
        id: 'images',
        label: (
          <TabLabel
            icon={<ImageIcon className="size-3.5" aria-hidden="true" />}
            label={localize('com_sources_tab_images')}
          />
        ),
        content: (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {sources.images.map((image) => (
              <ImageTile key={image.imageUrl} image={image} label={imageAltLabel} />
            ))}
          </div>
        ),
      });
    }
    if (sources.files.length > 0) {
      availableTabs.push({
        id: 'files',
        label: (
          <TabLabel
            icon={<File className="size-3.5" aria-hidden="true" />}
            label={localize('com_sources_tab_files')}
          />
        ),
        content: (
          <div className="flex flex-col gap-2">
            {sources.files.map((file) => (
              <FileRow
                key={`${file.file_id}-${file.filename}`}
                file={file}
                pagesLabel={pagesLabel}
              />
            ))}
          </div>
        ),
      });
    }
    return availableTabs;
  }, [sources, localize, imageAltLabel, pagesLabel]);

  let content: ReactElement;
  if (isLoading) {
    content = (
      <div className="text-text-primary flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  } else if (tabs.length === 0) {
    content = (
      <p className="text-text-secondary flex flex-1 items-center justify-center px-4 text-center text-sm">
        {localize('com_links_empty')}
      </p>
    );
  } else {
    content = <AnimatedTabs key={conversationId} tone="muted" tabs={tabs} />;
  }

  return (
    <div
      role="region"
      aria-label={localize('com_links_panel')}
      className="bg-surface-primary text-text-primary flex h-full w-full flex-col"
    >
      <div className="border-border-light flex shrink-0 items-center justify-between gap-2 border-b p-2">
        <div className="flex min-w-0 items-center gap-2 ps-1">
          <h2 className="truncate text-sm font-semibold">{localize('com_links_panel')}</h2>
          {count > 0 && (
            <span className="text-text-secondary shrink-0 text-xs font-medium">
              {localize('com_links_count', { count })}
            </span>
          )}
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={onClose}
          aria-label={localize('com_ui_close')}
          data-testid="links-panel-close"
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">{content}</div>
    </div>
  );
}
