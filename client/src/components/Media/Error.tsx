import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  Alert,
  Button,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  disclosureChevronVariants,
} from '@librechat/client';
import type { MediaJob } from 'librechat-data-provider';
import { useMediaJobDiagnostics } from '~/data-provider';
import { mediaErrorLabels } from './labels';
import { useMediaHost } from './host';
import { useLocalize } from '~/hooks';

export function MediaJobError({
  job,
}: {
  job: Pick<MediaJob, 'jobId' | 'version' | 'phase' | 'error'>;
}) {
  const host = useMediaHost();
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const available = !!job.error && ['failed', 'requires_attention'].includes(job.phase);
  const query = useMediaJobDiagnostics(host, job.jobId, job.version, available && open);
  const diagnostic = query.data?.diagnostic;
  const hasDetails =
    diagnostic &&
    [diagnostic.message, diagnostic.status, diagnostic.code, diagnostic.requestId].some(Boolean);
  if (!job.error) return null;
  return (
    <Alert variant="error">
      <p>{localize(mediaErrorLabels[job.error.code])}</p>
      {available && (
        <Collapsible open={open} onOpenChange={setOpen} className="group/disclosure mt-2">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              {localize('com_error_details_provider')}
              <ChevronDown
                className={disclosureChevronVariants({ expanded: open, className: 'size-3.5' })}
                aria-hidden="true"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="text-text-secondary space-y-2">
              {query.isFetching && !query.data && (
                <p role="status">{localize('com_media_diagnostics_loading')}</p>
              )}
              {query.isError && (
                <div className="space-y-2">
                  <p role="status">{localize('com_media_diagnostics_failed')}</p>
                  <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                    {localize('com_media_diagnostics_retry')}
                  </Button>
                </div>
              )}
              {query.isSuccess && !hasDetails && (
                <p role="status">{localize('com_media_diagnostics_unavailable')}</p>
              )}
              {diagnostic && hasDetails && (
                <div className="space-y-2">
                  {diagnostic.message && (
                    <p className="break-words whitespace-pre-wrap">{diagnostic.message}</p>
                  )}
                  <dl className="space-y-1 text-xs">
                    {diagnostic.status !== undefined && (
                      <div>
                        <dt className="inline font-medium">
                          {localize('com_media_diagnostics_status')}
                          {': '}
                        </dt>
                        <dd className="inline">{diagnostic.status}</dd>
                      </div>
                    )}
                    {diagnostic.code && (
                      <div>
                        <dt className="inline font-medium">
                          {localize('com_media_diagnostics_code')}
                          {': '}
                        </dt>
                        <dd className="inline break-words">{diagnostic.code}</dd>
                      </div>
                    )}
                    {diagnostic.requestId && (
                      <div>
                        <dt className="inline font-medium">
                          {localize('com_media_recovery_provider_request')}
                          {': '}
                        </dt>
                        <dd className="inline break-words">{diagnostic.requestId}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Alert>
  );
}
