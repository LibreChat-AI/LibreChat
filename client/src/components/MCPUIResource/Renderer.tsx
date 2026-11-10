import { Suspense } from 'react';
import {
  isHtmlMediaType,
  isMcpAppMimeType,
  resolveMCPUIResourceMimeType,
} from 'librechat-data-provider';
import type { UIResource } from 'librechat-data-provider';
import type { ComponentProps } from 'react';
import { importWithRecovery, lazyWithRecovery } from '~/lib/assets/lazy';
import { useMCPAppsPolicy } from '~/Providers/MCPAppsPolicyContext';
import { MCPAppLoading } from './MCPAppFrame';

/** The SDK behind this renderer is large, and only a deployment that serves legacy HTML needs it. */
const LegacyUIResourceRenderer = lazyWithRecovery(() =>
  importWithRecovery(() => import('@mcp-ui/client')).then((m) => ({
    default: m.UIResourceRenderer,
  })),
);

type LegacyRendererProps = ComponentProps<typeof LegacyUIResourceRenderer>;

type UIResourceRendererProps = Omit<
  LegacyRendererProps,
  'resource' | 'remoteDomProps' | 'supportedContentTypes'
> & {
  resource: UIResource;
};

export function isSupportedUIResource(
  resource: UIResource | null | undefined,
): resource is UIResource {
  if (!resource || (resource.mimeType != null && typeof resource.mimeType !== 'string')) {
    return false;
  }
  const mimeType = resolveMCPUIResourceMimeType(resource.mimeType);
  return !isMcpAppMimeType(mimeType) && isHtmlMediaType(mimeType);
}

/** Restricts legacy MCP-UI rendering to sandboxed inline HTML resources. */
export default function UIResourceRenderer({
  resource,
  htmlProps,
  ...props
}: UIResourceRendererProps) {
  const { legacyHtmlEnabled } = useMCPAppsPolicy();

  if (!legacyHtmlEnabled || !isSupportedUIResource(resource)) {
    return null;
  }

  const safeResource = { ...resource };
  const safeHtmlProps = { ...htmlProps };
  delete safeResource.contentType;
  safeResource.mimeType = 'text/html';
  delete safeHtmlProps.sandboxPermissions;

  return (
    <Suspense
      fallback={
        <span className="relative block min-h-16">
          <MCPAppLoading live={false} />
        </span>
      }
    >
      <LegacyUIResourceRenderer
        {...props}
        resource={safeResource}
        htmlProps={safeHtmlProps}
        supportedContentTypes={['rawHtml']}
      />
    </Suspense>
  );
}
