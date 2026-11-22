import { useState, useEffect, useRef, useCallback } from 'react';
import { PixelCard, useLocalize } from '@librechat/client';
import type {
  TAttachment,
  TFile,
  TAttachmentMetadata,
  PartMetadata,
} from 'librechat-data-provider';
import type { JSX } from 'react';
import { AGENT_STYLE_TOOLS } from '../../core/parts/routing';
import { useToolCallIntent } from '../../react/parts/intent';
import useProgress from '../../react/parts/useProgress';
import { scaleImage } from '../../core/scaleImage';
import { useToolPreparation } from './preparation';
import { isError } from '../../core/parts/output';
import ImageGenText from './ImageGenText';
import { ROW_GLYPH_SLOT } from './rows';
import ToolIcon from './ToolIcon';
import Image from './Image';

function computeCancelled(
  isSubmitting: boolean,
  initialProgress: number,
  hasError: boolean,
  runStepStatus?: PartMetadata['runStepStatus'],
): boolean {
  /**
   * The step's own terminal status wins when the run emitted one. Checked
   * first and not gated on `hasError`, so output parsing cannot demote a step
   * the run reported as stopped. Everything below is the pre-existing
   * inference, kept for messages saved before `on_run_step_closed`.
   */
  if (runStepStatus != null) {
    return runStepStatus === 'cancelled';
  }
  return (!isSubmitting && initialProgress < 1) || hasError;
}

type Quality = 'low' | 'medium' | 'high';

/** How long a preview takes to fill, by the quality the call asked for; a third is added at random. */
const FILL_MS: Record<Quality, number> = { low: 10000, medium: 20000, high: 50000 };

/** The call's arguments as an object, or none when they are not one yet (still streaming). */
function parseArgs(args: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof args !== 'string') {
    return args ?? {};
  }
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The `size` argument's `<width>x<height>`, when it is one. */
function parseSize(size: unknown): { width: number; height: number } | undefined {
  if (typeof size !== 'string') {
    return undefined;
  }
  const [width, height] = size.split('x').map((value) => parseInt(value, 10));
  return isNaN(width) || isNaN(height) ? undefined : { width, height };
}

function parseQuality(quality: unknown): Quality {
  const value = typeof quality === 'string' ? quality.toLowerCase() : '';
  return value === 'low' || value === 'medium' ? value : 'high';
}

export interface ImageGenProps {
  initialProgress: number;
  isSubmitting: boolean;
  toolName?: string;
  args: string | Record<string, unknown>;
  output?: string | null;
  attachments?: TAttachment[];
  hideAttachments?: boolean;
  runStepStatus?: PartMetadata['runStepStatus'];
}

/**
 * The card for an image-generation call. A tool in `AGENT_STYLE_TOOLS` previews the picture: a
 * placeholder the size the call asked for fills in while the run goes, and the image takes its
 * place. Any other image tool shows its status line alone.
 */
export default function ImageGen({
  initialProgress = 0.1,
  isSubmitting,
  toolName,
  args: _args = '',
  output,
  attachments,
  hideAttachments = false,
  runStepStatus,
}: ImageGenProps): JSX.Element {
  const localize = useLocalize();
  const preparationText = useToolPreparation();
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
   * Cancelled if not submitting + incomplete, or on error.
   */
  const cancelled = computeCancelled(isSubmitting, initialProgress, hasError, runStepStatus);
  /**
   * An explicit `cancelled` close is authoritative and outranks an
   * error-formatted output — aborting a tool can itself produce one. The
   * legacy inference keeps the opposite precedence, because it folds
   * `hasError` into its own cancellation signal.
   */
  const reportsError = hasError && runStepStatus !== 'cancelled';

  const parsedArgs = parseArgs(_args);
  const size = parseSize(parsedArgs.size);
  const quality = parseQuality(parsedArgs.quality);

  const attachment = attachments?.[0];
  const {
    width: imageWidth,
    height: imageHeight,
    filepath = null,
    filename = '',
  } = (attachment as TFile & TAttachmentMetadata) || {};

  /** The size the call asked for, else the attachment's, else a square until both are known. */
  const width = size?.width ?? imageWidth;
  const height = size?.height ?? imageHeight;
  const sized = width !== undefined && height !== undefined;
  const origWidth = sized ? width : 1024;
  const origHeight = sized ? height : 1024;

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

      const baseDuration = FILL_MS[quality];
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
            return preparationText ?? '';
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
      <div className="text-text-secondary relative my-1.5 flex h-5 shrink-0 items-center gap-2">
        <span className={ROW_GLYPH_SLOT} aria-hidden="true">
          <ToolIcon type="image_gen" isAnimating={isInProgress} />
        </span>
        <ImageGenText
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
