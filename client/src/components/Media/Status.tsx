import { Chip } from '@librechat/client';
import { Check, CircleAlert, Clock3, LoaderCircle, X } from 'lucide-react';
import type { MediaJobPhase } from 'librechat-data-provider';
import type { ChipProps } from '@librechat/client';
import { mediaJobPhaseLabels } from './labels';
import { useLocalize } from '~/hooks';

const phases = {
  queued: { tone: 'neutral', icon: Clock3 },
  submitting: { tone: 'info', icon: LoaderCircle },
  running: { tone: 'info', icon: LoaderCircle },
  ingesting: { tone: 'info', icon: LoaderCircle },
  reconciling: { tone: 'warning', icon: Clock3 },
  requires_attention: { tone: 'warning', icon: CircleAlert },
  succeeded: { tone: 'success', icon: Check },
  failed: { tone: 'error', icon: CircleAlert },
  cancelled: { tone: 'neutral', icon: X },
} satisfies Record<MediaJobPhase, { tone: ChipProps['tone']; icon: typeof Check }>;

export function MediaStatus({ phase }: { phase: MediaJobPhase }) {
  const localize = useLocalize();
  const { tone, icon: Icon } = phases[phase];
  return (
    <Chip tone={tone} leading={<Icon className="size-3.5" aria-hidden="true" />}>
      {localize(mediaJobPhaseLabels[phase])}
    </Chip>
  );
}
