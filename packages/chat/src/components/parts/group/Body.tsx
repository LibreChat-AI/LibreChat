import { cn } from '@librechat/client';
import { ContentTypes, isOpaqueReasoning } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { ReactElement, ReactNode } from 'react';
import { getPartKeyIndex } from '../../../core/content';
import { ReasoningCompact } from '../Reasoning';

export type ToolGroupBodyProps = {
  parts: { part: TMessageContentParts; idx: number }[];
  isSubmitting: boolean;
  isLast: boolean;
  showThinking: boolean;
  smoothStreaming: boolean;
  lastContentIdx: number;
  thinkingLabel: string;
  thoughtsLabel: string;
  renderPart: (
    part: TMessageContentParts,
    idx: number,
    isLastPart: boolean,
    onToolExpand?: () => void,
  ) => ReactNode;
  onToolExpand: () => void;
};

/** Inner rows only; the app owns disclosure, providers and the body mount lifetime. */
export default function ToolGroupBody({
  parts,
  isSubmitting,
  isLast,
  showThinking,
  smoothStreaming,
  lastContentIdx,
  thinkingLabel,
  thoughtsLabel,
  renderPart,
  onToolExpand,
}: ToolGroupBodyProps): ReactElement {
  return (
    <div className="flex flex-col py-0.5">
      {parts.map(({ part, idx }) => {
        if (part.type === ContentTypes.THINK) {
          const think = part.think;
          const reasoning = typeof think === 'string' ? think : (think?.value ?? '');
          /** A detached-subagent projection carries an empty THINK
           *  part flagged `reasoning_unavailable`, and encrypted
           *  reasoning has no readable text; `Part` renders both as a
           *  `ReasoningMarker`. `ReasoningCompact` would show the
           *  encoded payload or return null, so the marker has to
           *  keep going through the standalone path or it vanishes
           *  the moment its call joins a group. */
          if (
            (reasoning.trim() === '' && part.reasoning_unavailable === true) ||
            isOpaqueReasoning(reasoning)
          ) {
            return renderPart(part, idx, isLast && idx === lastContentIdx, onToolExpand);
          }
          /** `lastContentIdx` is the tail of this body, and every
           *  settled phase body has one. Only the group that holds
           *  the message's cursor has a thought still being written,
           *  the rule `PartWithContext` applies to a lone thought. */
          const streaming = isSubmitting && isLast && idx === lastContentIdx;
          /** Mirrors the standalone `Reasoning` path: the authored
           *  label wins, generic text is only a fallback. */
          const generatedLabel = part.reasoning_label?.trim();
          const label = generatedLabel || (streaming ? thinkingLabel : thoughtsLabel);
          return (
            <ReasoningCompact
              key={`reasoning-${idx}`}
              partKeyIndex={getPartKeyIndex(part, idx)}
              reasoning={reasoning}
              label={label}
              showThinking={showThinking}
              isStreaming={streaming}
            />
          );
        }
        return (
          <div
            key={`tool-${getPartKeyIndex(part, idx)}`}
            className={cn(
              isSubmitting &&
                smoothStreaming &&
                'animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none',
            )}
          >
            {renderPart(part, idx, isLast && idx === lastContentIdx, onToolExpand)}
          </div>
        );
      })}
    </div>
  );
}
