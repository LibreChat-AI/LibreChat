import { useId, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import {
  Button,
  FilterInput,
  OGDialog,
  OGDialogTitle,
  OGDialogContent,
  OGDialogDescription,
} from '@librechat/client';
import type { ComponentType, ReactElement } from 'react';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

export type ChannelKind = 'slack';

interface ChannelOption {
  kind: ChannelKind;
  icon: ComponentType<{ className?: string }>;
  name: TranslationKeys;
  description: TranslationKeys;
}

/** The Slack mark in its brand colors, served as an asset so the colors stay exact in every theme. */
const SlackLogo = ({ className }: { className?: string }): ReactElement => (
  <img src="assets/slack.svg" alt="" className={className} />
);

/** Messaging apps an agent can be connected to; Slack is the first. */
const CHANNELS: ChannelOption[] = [
  {
    kind: 'slack',
    icon: SlackLogo,
    name: 'com_ui_channels_slack',
    description: 'com_ui_channels_slack_description',
  },
];

interface ChannelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (kind: ChannelKind) => void;
}

/** The channel library: the same shell as the tool library, listing where an agent can be reached. */
export default function ChannelsDialog({ open, onOpenChange, onSelect }: ChannelsDialogProps) {
  const localize = useLocalize();
  const id = useId();
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const options = useMemo(
    () =>
      CHANNELS.filter(
        (channel) =>
          query === '' ||
          localize(channel.name).toLowerCase().includes(query) ||
          localize(channel.description).toLowerCase().includes(query),
      ),
    [query, localize],
  );

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-[40rem] overflow-hidden p-0 md:max-h-[92vh]">
        <OGDialogDescription className="sr-only">
          {localize('com_ui_channels_catalog_description')}
        </OGDialogDescription>
        <div className="flex min-w-0 flex-col">
          <div className="flex flex-col gap-5 px-4 pt-4 pb-3 md:px-6 md:pt-5">
            {/* Only the title shares a row with the dialog's close button, so only it keeps clear of it. */}
            <div className="pe-10">
              <OGDialogTitle>{localize('com_ui_channels_title')}</OGDialogTitle>
            </div>
            <FilterInput
              type="text"
              surface="dialog"
              inputId={`${id}-search`}
              label={localize('com_ui_channels_catalog_search')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="min-h-0 overflow-y-auto px-3 pb-4 md:px-5 md:pb-6">
            {options.length === 0 ? (
              <div
                role="status"
                className="flex flex-col items-center justify-center py-12 text-center"
              >
                <Search className="text-text-tertiary size-8 opacity-40" aria-hidden="true" />
                <p className="text-text-secondary mt-3 text-sm">
                  {localize('com_ui_channels_catalog_empty')}
                </p>
              </div>
            ) : (
              <ul
                className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                aria-label={localize('com_ui_channels_catalog_title')}
              >
                {options.map((channel) => {
                  const Icon = channel.icon;
                  return (
                    <li key={channel.kind}>
                      <div className="border-border-light hover:border-border-medium hover:bg-surface-tertiary rounded-2xl border">
                        <Button
                          type="button"
                          variant="card"
                          size="tile"
                          aria-describedby={`${id}-${channel.kind}`}
                          className="w-full flex-col items-stretch"
                          onClick={() => onSelect(channel.kind)}
                        >
                          <span className="flex items-start gap-3">
                            <span
                              className="border-border-light bg-surface-secondary text-text-primary flex size-10 shrink-0 items-center justify-center rounded-xl border"
                              aria-hidden="true"
                            >
                              <Icon className="size-5" />
                            </span>
                            <span className="flex min-w-0 flex-col">
                              <span className="text-text-primary text-sm font-semibold">
                                {localize(channel.name)}
                              </span>
                              <span className="text-text-secondary text-2xs tracking-wide uppercase">
                                {localize('com_ui_channels_kind_messaging')}
                              </span>
                            </span>
                          </span>
                          <span
                            id={`${id}-${channel.kind}`}
                            className="text-text-secondary mt-2 text-xs"
                          >
                            {localize(channel.description)}
                          </span>
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
