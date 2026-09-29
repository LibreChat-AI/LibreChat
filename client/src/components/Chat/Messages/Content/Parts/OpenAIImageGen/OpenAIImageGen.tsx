import { useState, useEffect, useRef, useCallback } from 'react';
import { AGENT_STYLE_TOOLS } from '.';
import { PixelCard } from '@librechat/client';
import type {
  TAttachment,
  TFile,
  TAttachmentMetadata,
  PartMetadata,
} from 'librechat-data-provider';
import { ToolIcon, isError } from '~/components/Chat/Messages/Content/ToolOutput';
import Image from '~/components/Chat/Messages/Content/Image';
import { useProgress, useLocalize } from '~/hooks';
import { useToolCallIntent } from '../intent';
import { ROW_GLYPH_SLOT } from '../../rows';
import ProgressText from './ProgressText';
import { scaleImage } from '~/utils';

function computeCancelled(
  isSubmitting: boolean | undefined,
  initialProgress: number,
  hasError: boolean,
  runStepStatus?: PartMetadata['runStepStatus'],
): boolean {
  /**
   * The step's own terminal status wins when the run emitted one. Checked
   * first and not gated on `hasError`, so output parsing cannot demote a step
   * the run reported as stopped. Everything below is the pre-existing
   * inference, kept for messages saved before `on_run_step_closed` and for the
   * legacy path that has no submitting signal at all.
   */
  if (runStepStatus != null) {
    return runStepStatus === 'cancelled';
  }
  if (isSubmitting !== undefined) {
    return (!isSubmitting && initialProgress < 1) || hasError;
  }
  // Legacy path: in-progress (0 < progress < 1) is never cancelled
  // because legacy image gen lacks a submitting signal.
  if (initialProgress < 1 && initialProgress > 0) {
    return false;
  }
  return hasError;
}

export default function OpenAIImageGen({
  initialProgress = 0.1,
  isSubmitting,
  toolName,
  args: _args = '',
  output,
  attachments,
  hideAttachments = false,
  runStepStatus,
}: {
  initialProgress: number;
  isSubmitting?: boolean;
  toolName?: string;
  args: string | Record<string, unknown>;
  output?: string | null;
  attachments?: TAttachment[];
  hideAttachments?: boolean;
  runStepStatus?: PartMetadata['runStepStatus'];
}) {
  const localize = useLocalize();
  /** Model-authored live label (injected when the tool is opted into
   *  describe_intent); wins over the phase texts. */
  const intent = useToolCallIntent(_args);
  const isAgentStyle = toolName != null && AGENT_STYLE_TOOLS.has(toolName);
  const [agentProgress, setAgentProgress] = useState(initialProgress);
  const isClosed = runStepStatus != null;
  /** Passing 1 in stops `useProgress` scheduling its interval; masking the
   *  result makes the terminal value observable on the same render, since the
   *  hook settles through 0.99 and a 200ms timeout. */
  const legacyProgress = useProgress(isAgentStyle || isClosed ? 1 : initialProgress);
  const livingProgress = isAgentStyle ? agentProgress : legacyProgress;
  const progress = isClosed ? 1 : livingProgress;
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const hasError = (typeof output === 'string' && isError(output)) || runStepStatus === 'failed';

  /**
   * Determines if the image generation was cancelled.
   * - Agent path (isSubmitting defined): cancelled if not submitting + incomplete, or on error.
   * - Legacy path (isSubmitting undefined): in-progress (0 < progress < 1) is never cancelled
   *   because legacy image gen lacks a submitting signal — only errors cancel.
   */
  const cancelled = computeCancelled(isSubmitting, initialProgress, hasError, runStepStatus);
  /**
   * An explicit `cancelled` close is authoritative and outranks an
   * error-formatted output — aborting a tool can itself produce one. The
   * legacy inference keeps the opposite precedence, because it folds
   * `hasError` into its own cancellation signal.
   */
  const reportsError = hasError && runStepStatus !== 'cancelled';

  let width: number | undefined;
  let height: number | undefined;
  let quality: 'low' | 'medium' | 'high' = 'high';

  let parsedArgs: Record<string, unknown> = {};
  try {
    parsedArgs = typeof _args === 'string' ? JSON.parse(_args) : _args;
  } catch {
    parsedArgs = {};
  }

  try {
    const argsObj = parsedArgs;

    if (argsObj && typeof argsObj.size === 'string') {
      const [w, h] = argsObj.size.split('x').map((v: string) => parseInt(v, 10));
      if (!isNaN(w) && !isNaN(h)) {
        width = w;
        height = h;
      }
    } else if (argsObj && (typeof argsObj.size !== 'string' || !argsObj.size)) {
      width = undefined;
      height = undefined;
    }

    if (argsObj && typeof argsObj.quality === 'string') {
      const q = argsObj.quality.toLowerCase();
      if (q === 'low' || q === 'medium' || q === 'high') {
        quality = q;
      }
    }
  } catch {
    width = undefined;
    height = undefined;
  }

  const attachment = attachments?.[0];
  const {
    width: imageWidth,
    height: imageHeight,
    filepath = null,
    filename = '',
  } = (attachment as TFile & TAttachmentMetadata) || {};

  let origWidth = width ?? imageWidth;
  let origHeight = height ?? imageHeight;

  if (origWidth === undefined || origHeight === undefined) {
    origWidth = 1024;
    origHeight = 1024;
  }

  const [dimensions, setDimensions] = useState({ width: 'auto', height: 'auto' });
  const containerRef = useRef<HTMLDivElement>(null);

  const updateDimensions = useCallback(() => {
    if (origWidth && origHeight && containerRef.current) {
      const scaled = scaleImage({
        originalWidth: origWidth,
        originalHeight: origHeight,
        containerRef,
      });
      setDimensions(scaled);
    }
  }, [origWidth, origHeight]);

  useEffect(() => {
    if (!isAgentStyle) {
      return;
    }

    if (isSubmitting && !isClosed) {
      setAgentProgress(initialProgress);

      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }

      let baseDuration = 20000;
      if (quality === 'low') {
        baseDuration = 10000;
      } else if (quality === 'high') {
        baseDuration = 50000;
      }
      const jitter = Math.floor(baseDuration * 0.3);
      const totalDuration = Math.floor(Math.random() * jitter) + baseDuration;
      const updateInterval = 200;
      const totalSteps = totalDuration / updateInterval;
      let currentStep = 0;

      intervalRef.current = setInterval(() => {
        currentStep++;

        if (currentStep >= totalSteps) {
          clearInterval(intervalRef.current as NodeJS.Timeout);
          setAgentProgress(0.9);
        } else {
          const progressRatio = currentStep / totalSteps;
          let mapRatio: number;
          if (progressRatio < 0.8) {
            mapRatio = Math.pow(progressRatio, 1.1);
          } else {
            const sub = (progressRatio - 0.8) / 0.2;
            mapRatio = 0.8 + (1 - Math.pow(1 - sub, 2)) * 0.2;
          }
          const scaledProgress = 0.1 + mapRatio * 0.8;

          setAgentProgress(scaledProgress);
        }
      }, updateInterval);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isSubmitting, initialProgress, quality, isAgentStyle, isClosed]);

  useEffect(() => {
    if (!isAgentStyle) {
      return;
    }

    if (initialProgress >= 1 || cancelled || isClosed) {
      setAgentProgress(initialProgress);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    }
  }, [initialProgress, cancelled, isAgentStyle, isClosed]);

  useEffect(() => {
    updateDimensions();

    const resizeObserver = new ResizeObserver(() => {
      updateDimensions();
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [updateDimensions]);

  const isInProgress = progress < 1 && !cancelled;

  return (
    <>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {(() => {
          if (progress < 1 && !cancelled && !reportsError) {
            return '';
          }
          if (reportsError) {
            return localize('com_ui_image_gen_failed');
          }
          if (cancelled) {
            return localize('com_ui_cancelled');
          }
          return intent ?? localize('com_ui_image_created');
        })()}
      </span>
      <div className="relative my-1 flex h-5 shrink-0 items-center gap-2 text-text-secondary">
        <span className={ROW_GLYPH_SLOT} aria-hidden="true">
          <ToolIcon type="image_gen" isAnimating={isInProgress} />
        </span>
        <ProgressText
          progress={progress}
          error={reportsError}
          cancelled={cancelled}
          toolName={toolName}
          intent={intent}
        />
      </div>
      {isAgentStyle && !hideAttachments && (
        <div className="relative mb-2 flex w-full justify-start">
          <div ref={containerRef} className="w-full max-w-lg">
            {dimensions.width !== 'auto' && progress < 1 && (
              <PixelCard
                variant="default"
                progress={progress}
                randomness={0.6}
                width={dimensions.width}
                height={dimensions.height}
              />
            )}
            {filepath && (
              <Image
                altText={filename}
                imagePath={filepath}
                width={Number(dimensions.width?.split('px')[0])}
                height={Number(dimensions.height?.split('px')[0])}
                args={parsedArgs}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
