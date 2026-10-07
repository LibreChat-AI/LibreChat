import { useId, useState } from 'react';
import axios from 'axios';
import {
  Button,
  Input,
  Label,
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  Radio,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@librechat/client';
import type {
  TLangfusePromptErrorBody,
  TLangfusePromptErrorCode,
  TLangfusePromptGetParams,
  TLangfusePromptListParams,
} from 'librechat-data-provider';
import type { FormEvent } from 'react';
import type { TranslationKeys } from '~/hooks';
import { useLangfusePromptQuery, useLangfusePromptsQuery } from '~/data-provider';
import { getResponseErrorCode } from '~/utils';
import { useLocalize } from '~/hooks';

type LangfusePromptsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type GetMode = 'production' | 'version';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function isGetMode(value: string): value is GetMode {
  return value === 'production' || value === 'version';
}

/** Codes whose whole copy is one localized sentence; `upstream` is handled separately below
 *  because its sentence needs the Langfuse HTTP status when the server sent one. */
const PROMPT_ERROR_MESSAGE_KEYS: Partial<Record<TLangfusePromptErrorCode, TranslationKeys>> = {
  not_configured: 'com_ui_langfuse_prompt_error_not_configured',
  unauthorized: 'com_ui_langfuse_prompt_error_unauthorized',
  timeout: 'com_ui_langfuse_prompt_error_timeout',
  invalid_response: 'com_ui_langfuse_prompt_error_invalid_response',
  not_found: 'com_ui_langfuse_prompt_error_not_found',
  unsupported_type: 'com_ui_langfuse_prompt_error_unsupported_type',
  invalid_request: 'com_ui_langfuse_prompt_error_invalid_request',
};

function getUpstreamStatus(error: unknown): number | undefined {
  if (!axios.isAxiosError<TLangfusePromptErrorBody>(error)) {
    return undefined;
  }
  const status = error.response?.data?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Maps a failed list or get call to one short localized line, with a generic fallback for an
 *  unmapped or missing code (for example a bare 404 with no body, which means the feature is off). */
function getPromptErrorMessage(error: unknown, localize: ReturnType<typeof useLocalize>): string {
  const code = getResponseErrorCode<TLangfusePromptErrorCode>(error);
  if (code === 'upstream') {
    const status = getUpstreamStatus(error);
    return status != null
      ? localize('com_ui_langfuse_prompt_error_upstream_status', { 0: status })
      : localize('com_ui_langfuse_prompt_error_upstream');
  }
  const messageKey = code != null ? PROMPT_ERROR_MESSAGE_KEYS[code] : undefined;
  return localize(messageKey ?? 'com_ui_langfuse_prompt_error_fallback');
}

/** A whole, positive integer, the way page, limit and version numbers must read. Rejects
 *  fractional input (`"1.5"`) and blanks instead of silently rounding or defaulting. */
function parsePositiveInt(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function toIsoDateTime(value: string): string | undefined {
  if (value.trim() === '') {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function buildListParams(fields: {
  name: string;
  label: string;
  tag: string;
  page: number;
  limit: number;
  fromUpdatedAt: string;
  toUpdatedAt: string;
}): TLangfusePromptListParams {
  const params: TLangfusePromptListParams = {
    page: fields.page,
    limit: fields.limit,
  };
  if (fields.name.trim() !== '') {
    params.name = fields.name.trim();
  }
  if (fields.label.trim() !== '') {
    params.label = fields.label.trim();
  }
  if (fields.tag.trim() !== '') {
    params.tag = fields.tag.trim();
  }
  const fromUpdatedAt = toIsoDateTime(fields.fromUpdatedAt);
  if (fromUpdatedAt != null) {
    params.fromUpdatedAt = fromUpdatedAt;
  }
  const toUpdatedAt = toIsoDateTime(fields.toUpdatedAt);
  if (toUpdatedAt != null) {
    params.toUpdatedAt = toUpdatedAt;
  }
  return params;
}

/**
 * A test-only, read-only "dry run" of the two Langfuse prompt calls: list prompts with filters,
 * and resolve one prompt by Production or an exact version. Nothing is written. Shown from
 * Settings ▸ Langfuse once the admin turns the "Langfuse prompts" switch on.
 */
export default function LangfusePromptsDialog({ open, onOpenChange }: LangfusePromptsDialogProps) {
  const localize = useLocalize();
  const dryRunNoticeId = useId();
  const listHeadingId = useId();
  const getHeadingId = useId();
  const getModeLabelId = useId();
  const listNameId = useId();
  const listLabelId = useId();
  const listTagId = useId();
  const listPageId = useId();
  const listLimitId = useId();
  const listFromId = useId();
  const listToId = useId();
  const getNameId = useId();

  const [listName, setListName] = useState('');
  const [listLabel, setListLabel] = useState('');
  const [listTag, setListTag] = useState('');
  const [listPage, setListPage] = useState(String(DEFAULT_PAGE));
  const [listLimit, setListLimit] = useState(String(DEFAULT_LIMIT));
  const [listFromUpdatedAt, setListFromUpdatedAt] = useState('');
  const [listToUpdatedAt, setListToUpdatedAt] = useState('');

  const [submittedListParams, setSubmittedListParams] = useState<TLangfusePromptListParams | null>(
    null,
  );
  const [listSubmitCount, setListSubmitCount] = useState(0);

  const parsedListPage = parsePositiveInt(listPage);
  const parsedListLimit = parsePositiveInt(listLimit);
  const canSubmitList =
    parsedListPage != null && parsedListLimit != null && parsedListLimit <= MAX_LIMIT;

  const listQuery = useLangfusePromptsQuery(submittedListParams ?? undefined, listSubmitCount);

  const handleListSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitList || parsedListPage == null || parsedListLimit == null) {
      return;
    }
    setSubmittedListParams(
      buildListParams({
        name: listName,
        label: listLabel,
        tag: listTag,
        page: parsedListPage,
        limit: parsedListLimit,
        fromUpdatedAt: listFromUpdatedAt,
        toUpdatedAt: listToUpdatedAt,
      }),
    );
    setListSubmitCount((count) => count + 1);
  };

  const [getName, setGetName] = useState('');
  const [getMode, setGetMode] = useState<GetMode>('production');
  const [getVersion, setGetVersion] = useState('');

  const [submittedGetParams, setSubmittedGetParams] = useState<TLangfusePromptGetParams | null>(
    null,
  );
  const [getSubmitCount, setGetSubmitCount] = useState(0);

  const trimmedGetName = getName.trim();
  const parsedGetVersion = parsePositiveInt(getVersion);
  const getVersionValid = parsedGetVersion != null;
  const canSubmitGet = trimmedGetName !== '' && (getMode === 'production' || getVersionValid);

  const getQuery = useLangfusePromptQuery(submittedGetParams ?? undefined, getSubmitCount);

  const handleGetSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmitGet) {
      return;
    }
    setSubmittedGetParams(
      getMode === 'version' && parsedGetVersion != null
        ? { name: trimmedGetName, version: parsedGetVersion }
        : { name: trimmedGetName },
    );
    setGetSubmitCount((count) => count + 1);
  };

  const listItems = listQuery.data?.items ?? [];
  const listMeta = listQuery.data?.meta;
  const listErrorMessage = listQuery.isError
    ? getPromptErrorMessage(listQuery.error, localize)
    : undefined;
  const getErrorMessage = getQuery.isError
    ? getPromptErrorMessage(getQuery.error, localize)
    : undefined;

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-3xl" aria-describedby={dryRunNoticeId}>
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_ui_langfuse_prompts_dialog_title')}</OGDialogTitle>
        </OGDialogHeader>
        <p id={dryRunNoticeId} className="text-text-secondary text-xs">
          {localize('com_ui_langfuse_prompts_dry_run_notice')}
        </p>

        <section
          className="border-border-light flex flex-col gap-3 border-t pt-4"
          aria-labelledby={listHeadingId}
        >
          <h3 id={listHeadingId} className="text-text-primary text-sm font-medium">
            {localize('com_ui_langfuse_prompts_list_title')}
          </h3>
          <form onSubmit={handleListSubmit} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={listNameId}>{localize('com_ui_langfuse_prompts_list_name')}</Label>
                <Input
                  id={listNameId}
                  value={listName}
                  onChange={(e) => setListName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={listLabelId}>
                  {localize('com_ui_langfuse_prompts_list_label')}
                </Label>
                <Input
                  id={listLabelId}
                  value={listLabel}
                  onChange={(e) => setListLabel(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={listTagId}>{localize('com_ui_langfuse_prompts_list_tag')}</Label>
                <Input
                  id={listTagId}
                  value={listTag}
                  onChange={(e) => setListTag(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={listPageId}>{localize('com_ui_langfuse_prompts_list_page')}</Label>
                <Input
                  id={listPageId}
                  type="number"
                  min={1}
                  value={listPage}
                  onChange={(e) => setListPage(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={listLimitId}>
                  {localize('com_ui_langfuse_prompts_list_limit')}
                </Label>
                <Input
                  id={listLimitId}
                  type="number"
                  min={1}
                  max={MAX_LIMIT}
                  value={listLimit}
                  onChange={(e) => setListLimit(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={listFromId}>{localize('com_ui_langfuse_prompts_list_from')}</Label>
                <Input
                  id={listFromId}
                  type="datetime-local"
                  value={listFromUpdatedAt}
                  onChange={(e) => setListFromUpdatedAt(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={listToId}>{localize('com_ui_langfuse_prompts_list_to')}</Label>
                <Input
                  id={listToId}
                  type="datetime-local"
                  value={listToUpdatedAt}
                  onChange={(e) => setListToUpdatedAt(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Button type="submit" disabled={!canSubmitList || listQuery.isFetching}>
                {listQuery.isFetching && <Spinner className="h-4 w-4" />}
                {localize('com_ui_langfuse_prompts_list_button')}
              </Button>
            </div>
          </form>
          <div aria-live="polite" className="flex flex-col gap-2">
            {listErrorMessage != null && (
              <p className="text-text-destructive text-sm">{listErrorMessage}</p>
            )}
            {listErrorMessage == null && listQuery.isFetched && listItems.length === 0 && (
              <p className="text-text-secondary text-sm">
                {localize('com_ui_langfuse_prompts_list_empty')}
              </p>
            )}
            {listErrorMessage == null && listItems.length > 0 && (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">
                        {localize('com_ui_langfuse_prompts_column_name')}
                      </TableHead>
                      <TableHead scope="col">
                        {localize('com_ui_langfuse_prompts_column_type')}
                      </TableHead>
                      <TableHead scope="col">
                        {localize('com_ui_langfuse_prompts_column_versions')}
                      </TableHead>
                      <TableHead scope="col">
                        {localize('com_ui_langfuse_prompts_column_labels')}
                      </TableHead>
                      <TableHead scope="col">
                        {localize('com_ui_langfuse_prompts_column_tags')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {listItems.map((item) => (
                      <TableRow key={item.name}>
                        <TableCell>{item.name}</TableCell>
                        <TableCell>{item.type}</TableCell>
                        <TableCell>{item.versions.join(', ')}</TableCell>
                        <TableCell>{item.labels.join(', ')}</TableCell>
                        <TableCell>{item.tags.join(', ')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {listMeta != null && (
                  <p className="text-text-secondary text-xs">
                    {localize('com_ui_langfuse_prompts_list_footer', {
                      0: listMeta.page,
                      1: listMeta.totalPages,
                      2: listMeta.totalItems,
                    })}
                  </p>
                )}
              </>
            )}
          </div>
        </section>

        <section
          className="border-border-light flex flex-col gap-3 border-t pt-4"
          aria-labelledby={getHeadingId}
        >
          <h3 id={getHeadingId} className="text-text-primary text-sm font-medium">
            {localize('com_ui_langfuse_prompts_get_title')}
          </h3>
          <form onSubmit={handleGetSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={getNameId}>{localize('com_ui_langfuse_prompts_get_name')}</Label>
              <Input id={getNameId} value={getName} onChange={(e) => setGetName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label id={getModeLabelId}>{localize('com_ui_langfuse_prompts_get_resolve')}</Label>
              <div className="flex flex-wrap items-center gap-3">
                <Radio
                  aria-labelledby={getModeLabelId}
                  value={getMode}
                  onChange={(value) => {
                    if (isGetMode(value)) {
                      setGetMode(value);
                    }
                  }}
                  options={[
                    {
                      value: 'production',
                      label: localize('com_ui_langfuse_prompts_get_production'),
                    },
                    {
                      value: 'version',
                      label: localize('com_ui_langfuse_prompts_get_version'),
                    },
                  ]}
                />
                {getMode === 'version' && (
                  <Input
                    type="number"
                    min={1}
                    aria-label={localize('com_ui_langfuse_prompts_get_version')}
                    value={getVersion}
                    onChange={(e) => setGetVersion(e.target.value)}
                    className="w-24"
                  />
                )}
              </div>
            </div>
            <div>
              <Button type="submit" disabled={!canSubmitGet || getQuery.isFetching}>
                {getQuery.isFetching && <Spinner className="h-4 w-4" />}
                {localize('com_ui_langfuse_prompts_get_button')}
              </Button>
            </div>
          </form>
          <div aria-live="polite" className="flex flex-col gap-2">
            {getErrorMessage != null && (
              <p className="text-text-destructive text-sm">{getErrorMessage}</p>
            )}
            {getErrorMessage == null && getQuery.data != null && (
              <div className="flex flex-col gap-2">
                <p className="text-text-secondary text-sm">
                  {localize('com_ui_langfuse_prompts_get_result', {
                    0: getQuery.data.version,
                    1: getQuery.data.labels.join(', '),
                  })}
                </p>
                <Textarea
                  readOnly
                  value={getQuery.data.prompt}
                  aria-label={localize('com_ui_langfuse_prompts_get_prompt_label')}
                  className="min-h-32"
                />
              </div>
            )}
          </div>
        </section>
      </OGDialogContent>
    </OGDialog>
  );
}
