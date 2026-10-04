import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@librechat/client';
import { mediaToolReceiptSchema } from 'librechat-data-provider';
import { mediaJobPhaseLabels } from '~/components/Media/labels';
import { useMediaAccess } from '~/hooks/Media/useMediaAccess';
import { useShareContext } from '~/Providers';
import { useLocalize } from '~/hooks';

export default function MediaToolReceipt({ output }: { output?: string | null }) {
  const localize = useLocalize();
  const { studio } = useMediaAccess();
  const { shareId } = useShareContext();
  const receipt = useMemo(() => {
    try {
      const value: unknown = JSON.parse(output ?? '');
      if (!value || typeof value !== 'object' || !('media' in value)) return;
      const parsed = mediaToolReceiptSchema.safeParse(value.media);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return;
    }
  }, [output]);
  if (!receipt) return null;
  return (
    <div className="text-text-secondary my-2 space-y-2 text-sm">
      <p>
        {localize('com_media_tool_reported_status', {
          status: localize(mediaJobPhaseLabels[receipt.phase]),
        })}
      </p>
      <p className="break-all">
        {localize('com_media_tool_job_reference', { jobId: receipt.jobId })}
      </p>
      {!shareId && studio ? (
        <Button asChild variant="outline" size="sm">
          <Link to={`/studio/threads/${encodeURIComponent(receipt.threadId)}`}>
            {localize('com_media_open_thread')}
          </Link>
        </Button>
      ) : (
        <p>{localize('com_media_tool_status_hint')}</p>
      )}
    </div>
  );
}
