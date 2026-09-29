import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { QrCode, ExternalLink } from 'lucide-react';
import {
  Input,
  Button,
  OGDialog,
  OGDialogTitle,
  OGDialogContent,
  OGDialogDescription,
} from '@librechat/client';
import CopyButton from '~/components/Messages/Content/CopyButton';
import { useLocalize, useCopyToClipboard } from '~/hooks';
import { cn, openInNewTab } from '~/utils';

interface McpOAuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverName: string;
  oauthUrl: string;
  /** The MCP server's icon, shown beside the title when the server provides one. */
  iconUrl?: string;
}

/**
 * Dedicated second dialog, opened ONLY when connecting an MCP server requires
 * OAuth. Offers three ways to finish: continue in this browser, copy the
 * authorization URL to open elsewhere, or reveal a QR code to scan on a phone.
 * Auto-closes once the server connects (the caller derives `open` from
 * connection state).
 */
export default function McpOAuthDialog({
  open,
  onOpenChange,
  serverName,
  oauthUrl,
  iconUrl,
}: McpOAuthDialogProps) {
  const localize = useLocalize();
  const [isCopying, setIsCopying] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [iconError, setIconError] = useState(false);
  const copyUrl = useCopyToClipboard({ text: oauthUrl });

  if (!oauthUrl) {
    return null;
  }

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-md overflow-hidden rounded-2xl">
        <div className="flex items-center gap-2">
          {iconUrl && !iconError && (
            <span
              className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white"
              aria-hidden="true"
            >
              <img
                src={iconUrl}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
                onError={() => setIconError(true)}
              />
            </span>
          )}
          <OGDialogTitle className="text-base font-semibold leading-6 text-text-primary">
            {localize('com_nav_mcp_connect_server', { 0: serverName })}
          </OGDialogTitle>
        </div>
        <OGDialogDescription className="text-sm text-text-secondary">
          {localize('com_ui_mcp_oauth_description')}
        </OGDialogDescription>

        <div className="flex flex-col gap-3 p-1">
          {/* Auto-height reveal via grid-template-rows 0fr -> 1fr so the QR slides
           * open smoothly without a hardcoded height, matching MCPToolItem. */}
          <div
            className={cn(
              'grid transition-[grid-template-rows] [transition-duration:var(--resize-dur)] [transition-timing-function:var(--resize-ease)] motion-reduce:transition-none',
              showQR ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div
                className={cn(
                  'flex flex-col items-center gap-2 pb-1 transition-opacity duration-200 ease-out motion-reduce:transition-none',
                  showQR ? 'opacity-100' : 'opacity-0',
                )}
              >
                <div className="rounded-2xl bg-white p-4 shadow-lg">
                  <QRCodeSVG
                    value={oauthUrl}
                    size={180}
                    marginSize={2}
                    title={localize('com_ui_mcp_oauth_qr_code_description')}
                  />
                </div>
                <span className="text-xs text-text-secondary">
                  {localize('com_ui_mcp_oauth_scan_qr')}
                </span>
              </div>
            </div>
          </div>

          <div className="relative">
            <Input
              type="text"
              readOnly
              dir="ltr"
              value={oauthUrl}
              aria-label={localize('com_ui_copy_link')}
              onFocus={(event) => event.currentTarget.select()}
              className="pr-10 text-text-secondary"
              data-testid="mcp-oauth-url"
            />
            <CopyButton
              iconOnly
              isCopied={isCopying}
              label={localize('com_ui_copy_link')}
              onClick={() => {
                if (!isCopying) {
                  copyUrl(setIsCopying);
                }
              }}
              className="absolute right-1 top-1/2 -translate-y-1/2"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              aria-expanded={showQR}
              aria-label={showQR ? localize('com_ui_hide_qr') : localize('com_ui_show_qr')}
              onClick={() => setShowQR((value) => !value)}
            >
              <QrCode className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="submit"
              className="flex-1"
              onClick={() => openInNewTab(oauthUrl)}
            >
              {localize('com_ui_continue_oauth')}
              <ExternalLink className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
