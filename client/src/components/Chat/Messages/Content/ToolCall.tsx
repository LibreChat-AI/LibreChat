import React, { useMemo, useState, useEffect, useContext, useCallback } from 'react';
import { Button } from '@librechat/client';
import {
  Constants,
  dataService,
  actionDelimiter,
  actionDomainSeparator,
  splitToolCallName,
} from 'librechat-data-provider';
import type { TAttachment, PartMetadata } from 'librechat-data-provider';
import {
  toolPanelSpacingClassName,
  useToolExpansion,
  LoneGroupContext,
  SoleToolContext,
} from './disclosure';
import { useLocalize, useProgress, useExpandCollapse, useLazyCollapseBody } from '~/hooks';
import { ToolIcon, getToolIconType, isError, hasRenderableOutput } from './ToolOutput';
import { cn, getToolDisplayLabel, logger, openInNewTab } from '~/utils';
import { isToolCallPreparing, useToolPreparation } from './preparation';
import { useMCPIconMap, useMCPServerNames } from '~/hooks/MCP';
import { resolveToolCallPhase } from '~/utils/toolCallPhase';
import { MCPAppViews } from '~/components/MCPUIResource';
import { useToolCallIntent } from './Parts/intent';
import { AttachmentGroup } from './Parts';
import ToolCallInfo from './ToolCallInfo';
import ProgressText from './ProgressText';
import { TOOL_ROW_CLASSES } from './rows';
import { hasToolParams } from './params';
import { ToolAuthWarning } from './auth';
import { firstErrorLine } from './live';
import useRowHandoff from './handoff';

export default function ToolCall({
  initialProgress = 0.1,
  isLast = false,
  isSubmitting,
  toolCallId,
  name,
  args: _args = '',
  output,
  attachments,
  auth,
  hideAttachments = false,
  onExpand,
  runStepStatus,
  runStepDurationMs,
  toolPreparationStartedAt,
  toolDispatchedAt,
  toolPreparationDurationMs,
  toolExecutionDurationMs,
}: {
  initialProgress: number;
  isLast?: boolean;
  isSubmitting: boolean;
  toolCallId?: string;
  name: string;
  args: string | Record<string, unknown>;
  output?: string | null;
  attachments?: TAttachment[];
  auth?: string;
  hideAttachments?: boolean;
  onExpand?: () => void;
  runStepStatus?: PartMetadata['runStepStatus'];
  runStepDurationMs?: PartMetadata['runStepDurationMs'];
  toolPreparationStartedAt?: PartMetadata['toolPreparationStartedAt'];
  toolDispatchedAt?: PartMetadata['toolDispatchedAt'];
  toolPreparationDurationMs?: PartMetadata['toolPreparationDurationMs'];
  toolExecutionDurationMs?: PartMetadata['toolExecutionDurationMs'];
}) {
  const localize = useLocalize();
  const [oauthError, setOAuthError] = useState<string | null>(null);
  const [oauthBinding, setOAuthBinding] = useState<'pending' | 'bound' | 'failed'>('pending');

  const parsedAuthUrl = useMemo(() => {
    if (!auth) {
      return null;
    }
    try {
      return new URL(auth);
    } catch {
      return null;
    }
  }, [auth]);

  const mcpServerNames = useMCPServerNames();
  const { function_name, domain, isMCPToolCall, mcpServerName } = useMemo(() => {
    if (typeof name !== 'string') {
      return { function_name: '', domain: null, isMCPToolCall: false, mcpServerName: '' };
    }
    if (name.includes(Constants.mcp_delimiter)) {
      const [func, server = ''] = splitToolCallName(name, mcpServerNames);
      const displayName = func === 'oauth' ? server : func;
      return {
        function_name: displayName || '',
        domain: server && (server.replaceAll(actionDomainSeparator, '.') || null),
        isMCPToolCall: true,
        mcpServerName: server || '',
      };
    }

    if (parsedAuthUrl) {
      const redirectUri = parsedAuthUrl.searchParams.get('redirect_uri') || '';
      const mcpMatch = redirectUri.match(/\/api\/mcp\/([^/]+)\/oauth\/callback/);
      if (mcpMatch?.[1]) {
        return {
          function_name: mcpMatch[1],
          domain: null,
          isMCPToolCall: true,
          mcpServerName: mcpMatch[1],
        };
      }
    }

    const [func, _domain] = name.includes(actionDelimiter)
      ? name.split(actionDelimiter)
      : [name, ''];
    return {
      function_name: func || '',
      domain: _domain && (_domain.replaceAll(actionDomainSeparator, '.') || null),
      isMCPToolCall: false,
      mcpServerName: '',
    };
  }, [name, parsedAuthUrl, mcpServerNames]);

  const toolIconType = useMemo(() => getToolIconType(name), [name]);
  const displayFunctionName = useMemo(
    () =>
      /** `function_name` has already had the MCP delimiter and server stripped
       *  above, so re-parsing it would classify an MCP function that happens to
       *  share a built-in's name (`read_file`, `set_memory`) as that native
       *  tool and show, and announce, an unrelated label. */
      isMCPToolCall ? function_name : getToolDisplayLabel(function_name, localize, mcpServerNames),
    [function_name, isMCPToolCall, localize, mcpServerNames],
  );
  const mcpIconMap = useMCPIconMap();
  const mcpIconUrl = isMCPToolCall ? mcpIconMap.get(mcpServerName) : undefined;

  const actionId = useMemo(() => {
    if (isMCPToolCall || !parsedAuthUrl) {
      return '';
    }
    const redirectUri = parsedAuthUrl.searchParams.get('redirect_uri') || '';
    const match = redirectUri.match(/\/api\/actions\/([^/]+)\/oauth\/callback/);
    return match?.[1] || '';
  }, [parsedAuthUrl, isMCPToolCall]);

  /**
   * Sets the CSRF cookie the OAuth callback checks when the provider redirects back, or returns
   * null when this prompt has nothing to bind.
   */
  const bindOAuth = useCallback((): Promise<void> | null => {
    const bindsMCP = isMCPToolCall && mcpServerName.length > 0;
    if (!bindsMCP && !actionId) {
      return null;
    }
    return (async () => {
      if (bindsMCP) {
        await dataService.bindMCPOAuth(mcpServerName);
      } else {
        await dataService.bindActionOAuth(actionId);
      }
    })();
  }, [isMCPToolCall, mcpServerName, actionId]);

  const hasError = (typeof output === 'string' && isError(output)) || runStepStatus === 'failed';
  /**
   * The step's own terminal status wins when the run emitted one. The
   * `isSubmitting` heuristic below it is a whole-message inference: it cannot
   * tell which step actually stopped, so it holds every unfinished call in a
   * running state until the entire response ends and then flips them all to
   * cancelled at once. Retained as the fallback for messages saved before
   * `on_run_step_closed` and for endpoints that do not emit it.
   *
   * The status is authoritative on its own terms — deliberately not gated on
   * `hasError`, so output parsing cannot demote a stopped step back into an
   * in-flight state.
   */
  const isClosed = runStepStatus != null;

  const args = useMemo(() => {
    if (typeof _args === 'string') {
      return _args;
    }
    try {
      return JSON.stringify(_args, null, 2);
    } catch (e) {
      logger.error(
        'client/src/components/Chat/Messages/Content/ToolCall.tsx - Failed to stringify args',
        e,
      );
      return '';
    }
  }, [_args]) as string | undefined;

  const hasInfo = useMemo(
    () => (args?.length ?? 0) > 0 || (output?.length ?? 0) > 0,
    [args, output],
  );
  /** The preference opens a card once it has output; a sole call opens on
   *  its arguments too, so a call that returned nothing still shows them. */
  const soleTool = useContext(SoleToolContext) === true;
  const authDomain = useMemo(() => {
    return parsedAuthUrl?.hostname ?? '';
  }, [parsedAuthUrl]);

  /**
   * Both halves are load-bearing: passing 1 in stops `useProgress` scheduling
   * its 200ms interval, and masking the result makes the terminal value
   * observable on the same render rather than after the hook settles.
   */
  const rawProgress = useProgress(isClosed ? 1 : initialProgress);
  /**
   * One resolution, read by the label, the live region, the icon and the
   * shimmer alike. It also unifies two inputs that had drifted apart: the
   * cancellation inference read `initialProgress` while the label read the
   * animated `rawProgress`.
   */
  const phase = resolveToolCallPhase({
    runStepStatus,
    displayProgress: rawProgress,
    reportedProgress: initialProgress,
    isSubmitting,
    hasError,
  });
  const showOAuth = Boolean(auth) && phase === 'running';

  const [expandedInfo, setShowInfo] = useToolExpansion(
    soleTool ? hasInfo : (output?.length ?? 0) > 0,
  );
  /** The only call of its group, settled successfully: the group header is the
   *  row, so the panel stands alone and stays open. An MCP or action call keeps
   *  its row, the only place its function name and domain appear, as does a call
   *  with a model-authored intent. */
  const intent = useToolCallIntent(_args);
  const isActionCall = domain != null && domain !== '';
  const loneGroup = useContext(LoneGroupContext);
  /** The cheap, identity and phase checks run first: a streaming call re-renders
   *  on every argument delta, and the panel check parses its payload. */
  const bare =
    phase === 'completed' &&
    (soleTool || loneGroup) &&
    !isMCPToolCall &&
    !isActionCall &&
    intent == null &&
    hasInfo &&
    (hasToolParams(args) || hasRenderableOutput(output));
  const showInfo = bare || expandedInfo;
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(showInfo);
  const rowRef = useRowHandoff(bare);
  const { shouldRenderBody, mountBody, handleTransitionEnd } = useLazyCollapseBody(showInfo);

  /**
   * Binds when the sign-in prompt appears instead of on tap, so the tap opens the provider
   * synchronously: an iOS home-screen app drops a tab opened after an awaited request. The button
   * stays disabled until the bind lands, so the provider cannot redirect back before its cookie.
   */
  useEffect(() => {
    if (!showOAuth) {
      return;
    }
    const binding = bindOAuth();
    if (binding == null) {
      setOAuthBinding('bound');
      return;
    }
    let active = true;
    setOAuthBinding('pending');
    binding.then(
      () => {
        if (active) {
          setOAuthBinding('bound');
        }
      },
      (error: unknown) => {
        logger.error('Failed to bind OAuth CSRF cookie', error);
        if (active) {
          setOAuthBinding('failed');
        }
      },
    );
    return () => {
      active = false;
    };
  }, [showOAuth, auth, bindOAuth]);

  const handleOAuthClick = useCallback(() => {
    if (!auth || oauthBinding === 'pending') {
      return;
    }
    if (oauthBinding === 'bound') {
      setOAuthError(null);
      openInNewTab(auth);
      /**
       * Live prompts share one CSRF cookie per callback path, so the last prompt to bind owns it.
       * The tapped prompt claims it again after opening; the provider cannot redirect back before
       * the user signs in, and the session cookie from the earlier bind covers a faster callback.
       */
      bindOAuth()?.catch((error: unknown) => {
        logger.error('Failed to bind OAuth CSRF cookie', error);
      });
      return;
    }
    setOAuthError(localize('com_ui_oauth_error_generic'));
    setOAuthBinding('pending');
    (bindOAuth() ?? Promise.resolve()).then(
      () => {
        setOAuthBinding('bound');
        setOAuthError(null);
      },
      (error: unknown) => {
        logger.error('Failed to bind OAuth CSRF cookie', error);
        setOAuthBinding('failed');
      },
    );
  }, [auth, oauthBinding, bindOAuth, localize]);

  const handleToggleInfo = useCallback(() => {
    mountBody();
    if (!showInfo) {
      onExpand?.();
    }
    setShowInfo(!showInfo);
  }, [mountBody, onExpand, setShowInfo, showInfo]);

  /** A failed row spends its subtitle on the error's first line: what went
   *  wrong is the fact the reader needs from that slot, ahead of which server
   *  the call went through. */
  const subtitle = useMemo(() => {
    const errorLine = phase === 'failed' ? firstErrorLine(output) : '';
    if (errorLine.length > 0) {
      return errorLine;
    }
    if (isMCPToolCall && mcpServerName) {
      return localize('com_ui_via_server', { 0: mcpServerName });
    }
    if (domain && domain.length !== Constants.ENCODED_DOMAIN_LENGTH) {
      return localize('com_ui_via_server', { 0: domain });
    }
    return undefined;
  }, [phase, output, isMCPToolCall, mcpServerName, domain, localize]);

  /** Model-authored live label, streamed as the first args key (injected by
   *  the `tool_intents` capability); persists as the settled label —
   *  completion is a UI state, not a tense change. */
  const preparationText = useToolPreparation();
  const preparing = useMemo(
    () =>
      isToolCallPreparing({
        args: _args,
        output,
        progress: initialProgress,
        toolPreparationStartedAt,
        toolDispatchedAt,
        runStepStatus,
      }),
    [_args, output, initialProgress, toolPreparationStartedAt, toolDispatchedAt, runStepStatus],
  );
  const subject = intent ?? displayFunctionName;
  let inProgressText =
    intent ??
    (displayFunctionName
      ? localize('com_assistants_running_var', { 0: displayFunctionName })
      : localize('com_assistants_running_action'));
  if (toolDispatchedAt != null) {
    inProgressText = localize('com_ui_tool_calling', { 0: subject });
  } else if (preparing) {
    inProgressText =
      preparationText ??
      (displayFunctionName
        ? localize('com_ui_tool_preparing', { 0: displayFunctionName })
        : localize('com_assistants_preparing_action'));
  }

  const getFinishedText = () => {
    if (phase === 'cancelled') {
      return localize('com_ui_cancelled');
    }
    /**
     * Announced before the completion strings below: a terminal step that
     * errored must not reach the live region as "completed", which would tell
     * a screen-reader user the opposite of what the card shows.
     */
    if (phase === 'failed') {
      /** The subject is the work the call named for itself, as on the live
       *  header and the collapsed card's peek, so the same failure reads the
       *  same wherever it is summarized. */
      const subject = intent ?? displayFunctionName;
      return subject
        ? localize('com_ui_failed_subject', { 0: subject })
        : localize('com_ui_failed');
    }
    if (intent != null) {
      return intent;
    }
    if (isMCPToolCall === true) {
      return localize('com_assistants_completed_function', { 0: displayFunctionName });
    }
    if (domain != null && domain && domain.length !== Constants.ENCODED_DOMAIN_LENGTH) {
      return localize('com_assistants_completed_action', { 0: domain });
    }
    return localize('com_assistants_completed_function', { 0: displayFunctionName });
  };

  if (!isLast && (!function_name || function_name.length === 0) && !output) {
    return null;
  }

  return (
    <>
      {/* The live region gets a STABLE in-progress value: the streaming
          intent grows on every delta, and an atomic polite region would
          re-announce the whole sentence each time. The settled intent is
          announced once via getFinishedText. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {(() => {
          if (phase === 'running') {
            if (toolDispatchedAt != null) {
              return localize('com_ui_tool_calling', { 0: displayFunctionName });
            }
            if (preparing) {
              return inProgressText;
            }
            return displayFunctionName
              ? localize('com_assistants_running_var', { 0: displayFunctionName })
              : localize('com_assistants_running_action');
          }
          return getFinishedText();
        })()}
      </span>
      {!bare && (
        <div
          className={TOOL_ROW_CLASSES}
          ref={rowRef}
          data-testid="tool-call"
          data-tool-call-id={toolCallId}
        >
          <ProgressText
            phase={phase}
            onClick={handleToggleInfo}
            inProgressText={inProgressText}
            authText={
              phase === 'running' && authDomain.length > 0
                ? localize('com_ui_requires_auth')
                : undefined
            }
            finishedText={getFinishedText()}
            subtitle={subtitle}
            durationMs={runStepDurationMs}
            toolPreparationDurationMs={toolPreparationDurationMs}
            toolExecutionDurationMs={toolExecutionDurationMs}
            phaseStartAt={toolDispatchedAt ?? toolPreparationStartedAt}
            icon={
              <ToolIcon
                type={toolIconType}
                iconUrl={mcpIconUrl}
                isAnimating={phase === 'running'}
              />
            }
            hasInput={hasInfo}
            isExpanded={showInfo}
          />
        </div>
      )}
      <div
        style={expandStyle}
        onTransitionEnd={handleTransitionEnd}
        data-tool-call-output-id={toolCallId}
      >
        <div className="overflow-hidden" ref={expandRef}>
          {hasInfo && shouldRenderBody && (
            <div
              className={cn(
                toolPanelSpacingClassName,
                'border-border-light bg-surface-secondary overflow-hidden rounded-lg border',
              )}
            >
              <ToolCallInfo input={args ?? ''} output={output} />
            </div>
          )}
        </div>
      </div>
      {showOAuth && (
        <div className="flex w-full flex-col gap-2.5">
          <div className="mt-2 mb-1">
            <Button
              className="inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium"
              variant="default"
              rel="noopener noreferrer"
              disabled={oauthBinding === 'pending'}
              aria-busy={oauthBinding === 'pending'}
              onClick={handleOAuthClick}
            >
              {localize('com_ui_sign_in_to_domain', { 0: authDomain })}
            </Button>
          </div>
          {oauthError && (
            <p role="alert" className="text-text-destructive text-sm">
              {oauthError}
            </p>
          )}
          <ToolAuthWarning />
        </div>
      )}
      {!hideAttachments && attachments && attachments.length > 0 && (
        <>
          <AttachmentGroup attachments={attachments} />
          <MCPAppViews attachments={attachments} />
        </>
      )}
    </>
  );
}
