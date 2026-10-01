import crypto from 'node:crypto';
import {
  Tools,
  DEFAULT_MCP_APP_PERSISTED_BYTES,
  MCP_APP_MIME_TYPE,
  isHtmlMediaType,
  isMcpAppMimeType,
  resolveMCPAppsPolicy,
  resolveMCPUIResourceMimeType,
} from 'librechat-data-provider';
import type { UIResource, TMCPAppsPolicy } from 'librechat-data-provider';
import type * as t from './types';

export const DEFAULT_MCP_IMAGE_DATA_MAX_BYTES: number = 10 * 1024 * 1024;

function generateResourceId(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 10);
}

/**
 * Derives a UI resource ID that is unique per result snapshot. The frontend indexes conversation
 * resources by ID, so two calls that share a base (resourceUri/text) and args but differ in
 * structuredContent, text content, _meta, or error state must not collide and overwrite each other.
 */
function deriveResourceId(
  base: string,
  result: t.MCPToolCallResponse,
  toolArgs: unknown,
  serverName?: string,
  toolName?: string,
): string {
  const meta = (result as { _meta?: unknown } | undefined)?._meta;
  const parts = [
    serverName ?? '',
    toolName ?? '',
    base,
    result?.structuredContent != null ? JSON.stringify(result.structuredContent) : '',
    result?.content != null ? JSON.stringify(result.content) : '',
    meta != null ? JSON.stringify(meta) : '',
    result?.isError === true ? '1' : '',
    toolArgs != null ? JSON.stringify(toolArgs) : '',
  ];
  return generateResourceId(parts.join('\x00'));
}

function fitsPersistedAppLimit(resource: UIResource, maxBytes: number): boolean {
  try {
    return (
      Buffer.byteLength(JSON.stringify({ [Tools.ui_resources]: { data: [resource] } }), 'utf8') <=
      maxBytes
    );
  } catch {
    return false;
  }
}

function getMCPImageDataMaxBytes(): number {
  const raw = process.env.MCP_IMAGE_DATA_MAX_BYTES;
  if (!raw) {
    return DEFAULT_MCP_IMAGE_DATA_MAX_BYTES;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_IMAGE_DATA_MAX_BYTES;
}

function getBase64Padding(data: string): number {
  if (data.endsWith('==')) {
    return 2;
  }
  if (data.endsWith('=')) {
    return 1;
  }
  return 0;
}

function estimateBase64ImageBytes(data: string): number {
  const padding = getBase64Padding(data);
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function isRemoteImageUrl(data: string): boolean {
  return data.startsWith('http://') || data.startsWith('https://');
}

function assertImageDataWithinLimit(item: t.ImageContent): void {
  if (isRemoteImageUrl(item.data)) {
    return;
  }

  const maxBytes = getMCPImageDataMaxBytes();
  const estimatedBytes = estimateBase64ImageBytes(item.data);
  if (estimatedBytes <= maxBytes) {
    return;
  }

  throw new Error(
    `MCP image result exceeds maximum size of ${maxBytes} bytes: ${estimatedBytes} bytes`,
  );
}

const RECOGNIZED_PROVIDERS = new Set([
  'google',
  'anthropic',
  'openai',
  'azureopenai',
  'openrouter',
  'xai',
  'deepseek',
  'ollama',
  'bedrock',
]);

const imageFormatters: Record<string, undefined | t.ImageFormatter> = {
  // google: (item) => ({
  //   type: 'image',
  //   inlineData: {
  //     mimeType: item.mimeType,
  //     data: item.data,
  //   },
  // }),
  // anthropic: (item) => ({
  //   type: 'image',
  //   source: {
  //     type: 'base64',
  //     media_type: item.mimeType,
  //     data: item.data,
  //   },
  // }),
  default: (item) => ({
    type: 'image_url',
    image_url: {
      url: isRemoteImageUrl(item.data) ? item.data : `data:${item.mimeType};base64,${item.data}`,
    },
  }),
};

function isImageContent(item: t.ToolContentPart): item is t.ImageContent {
  return item.type === 'image';
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Reads the body an MCP server embedded in a resource result. A server may deliver the same file
 * either as `text` or, under the very same schema, as a base64 `blob`, so both halves are unwrapped
 * here — reading only `text` leaves a blob-delivered file as bare URI and MIME type metadata.
 *
 * Image blobs become artifacts, matching standalone image content. Binary blobs are summarized
 * rather than emitted, so they never reach the model as base64. A NUL byte marks a payload binary
 * on its own, the way git classifies a file: NUL is valid UTF-8, so decoding alone would pass a
 * compiled binary through as text.
 */
function readResourceBody(resource: t.ResourceContents): t.ResourceBody {
  if ('text' in resource && typeof resource.text === 'string' && resource.text) {
    return { text: resource.text };
  }
  if (!('blob' in resource) || typeof resource.blob !== 'string' || !resource.blob) {
    return {};
  }

  const mimeType = resource.mimeType;
  if (mimeType != null && mimeType.toLowerCase().startsWith('image/')) {
    return { image: { type: 'image', data: resource.blob, mimeType } };
  }

  const bytes = Buffer.from(resource.blob, 'base64');
  if (bytes.includes(0)) {
    return { binaryBytes: bytes.byteLength };
  }
  try {
    const text = utf8Decoder.decode(bytes);
    return text ? { text } : {};
  } catch {
    return { binaryBytes: bytes.byteLength };
  }
}

function hasUsableAppBody(resource: t.ResourceContents): boolean {
  if ('text' in resource && typeof resource.text === 'string' && resource.text.length > 0) {
    return true;
  }
  if (!('blob' in resource) || typeof resource.blob !== 'string' || !resource.blob) {
    return false;
  }

  const encoded = resource.blob.replace(/[\t\n\f\r ]/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return false;
  }
  try {
    const decoded = utf8Decoder.decode(Buffer.from(encoded, 'base64'));
    return decoded.length > 0 && !decoded.includes('\0');
  } catch {
    return false;
  }
}

export function selectResolvedAppResource(
  contents: t.ResourceContents[] | undefined,
  resourceUri: string,
): t.ResourceContents | undefined {
  return contents?.find(
    (resource) =>
      resource.uri === resourceUri &&
      isMcpAppMimeType(resource.mimeType) &&
      hasUsableAppBody(resource),
  );
}

const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;

/**
 * Resource metadata renders as a single labeled line, so a line break inside one lets whoever
 * controls it — a hostile server, or merely whoever named a file the server relays — close the
 * line early and forge further labels, passing attacker text off as another field. Only these
 * one-line fields are flattened; resource bodies keep their line breaks, being the payload.
 */
function flattenMetadata(value: string): string {
  return value.replace(LINE_BREAKS, ' ');
}

function describeBinaryResource(bytes: number): string {
  return `Resource Content: ${bytes} bytes of binary data (omitted; not UTF-8 text)`;
}

function describeResourceLink(item: t.ResourceLink): string[] {
  const lines: string[] = [];
  if (item.name) {
    lines.push(`Resource Name: ${flattenMetadata(item.name)}`);
  }
  if (item.title) {
    lines.push(`Resource Title: ${flattenMetadata(item.title)}`);
  }
  if (item.description) {
    lines.push(`Resource Description: ${flattenMetadata(item.description)}`);
  }
  if (item.uri) {
    lines.push(`Resource URI: ${flattenMetadata(item.uri)}`);
  }
  if (item.mimeType) {
    lines.push(`Resource MIME Type: ${flattenMetadata(item.mimeType)}`);
  }
  if (typeof item.size === 'number') {
    lines.push(`Resource Size: ${item.size} bytes`);
  }
  return lines;
}

function parseAsString(result: t.MCPToolCallResponse): string {
  const content = result?.content ?? [];
  if (!content.length) {
    return '(No response)';
  }

  const text = content
    .map((item) => {
      if (item.type === 'text') {
        return item.text;
      }
      if (item.type === 'resource_link') {
        return describeResourceLink(item).join('\n');
      }
      if (item.type === 'resource') {
        const resourceText = [];
        // A ui:// HTML body is a whole document meant for the sandbox, never model context.
        if (!isRenderableUiResource(item)) {
          const body = readResourceBody(item.resource);
          if (body.text) {
            resourceText.push(body.text);
          } else if (body.image) {
            assertImageDataWithinLimit(body.image);
            resourceText.push(`data:${body.image.mimeType};base64,${body.image.data}`);
          } else if (body.binaryBytes != null) {
            resourceText.push(describeBinaryResource(body.binaryBytes));
          }
        }
        if (item.resource.uri) {
          resourceText.push(`Resource URI: ${flattenMetadata(item.resource.uri)}`);
        }
        if (item.resource.mimeType != null && item.resource.mimeType) {
          resourceText.push(`Type: ${flattenMetadata(item.resource.mimeType)}`);
        }
        return resourceText.join('\n');
      }
      if (isImageContent(item)) {
        assertImageDataWithinLimit(item);
      }
      return JSON.stringify(item, null, 2);
    })
    .filter(Boolean)
    .join('\n\n');

  return text;
}

function isUiResource(
  item: t.ToolContentPart,
): item is Extract<t.ToolContentPart, { type: 'resource' }> {
  const uri = item.type === 'resource' ? item.resource?.uri : undefined;
  return typeof uri === 'string' && uri.startsWith('ui://');
}

/**
 * MCP Apps renders only `ui://` resources whose mime type is HTML (mime omitted defaults to HTML),
 * the single renderable resource type the spec defines.
 *
 * Deliberately wider than `isMcpAppMimeType`: a plain `text/html` `ui://` resource still renders
 * through the legacy HTML renderer. Both tiers parse the media type through the same shared helpers, so a
 * differently-cased `Text/HTML;profile=mcp-app` cannot be renderable to one and not the other.
 */
export function isRenderableUiResource(item: t.ToolContentPart): boolean {
  if (!isUiResource(item)) {
    return false;
  }
  return isHtmlMediaType(resolveMCPUIResourceMimeType(item.resource.mimeType));
}

/**
 * Converts MCPToolCallResponse content into a plain-text string plus optional artifacts
 * (images, UI resources). All providers receive string content; images are separated into
 * artifacts and merged back by the agents package via formatArtifactPayload / formatAnthropicArtifactContent.
 *
 * @param provider - Used only to distinguish recognized vs. unrecognized providers.
 * All recognized providers currently produce identical string output;
 * provider-specific artifact merging is delegated to the agents package.
 */
export function formatToolContent(
  result: t.MCPToolCallResponse,
  provider: t.Provider,
  metadata?: {
    serverName?: string;
    toolName?: string;
    resourceUri?: string;
    resolvedAppResource?: t.ResourceContents;
    serverBinding?: string;
    toolArgs?: Record<string, unknown>;
    mcpApps?: TMCPAppsPolicy;
  },
): t.FormattedContentResult {
  const mcpApps = metadata?.mcpApps ?? resolveMCPAppsPolicy();
  const isRecognizedProvider = RECOGNIZED_PROVIDERS.has(provider);
  // Truthiness, not != null: an empty resourceUri/serverName/toolName cannot address an app, and a
  // single predicate keeps this gate and the synthesis below from drifting apart.
  const hasSyntheticApp = !!(
    metadata?.resourceUri &&
    metadata.serverName &&
    metadata.toolName &&
    metadata.serverBinding
  );
  const hasUiResource = result?.content?.some((item) => isUiResource(item));
  if (!isRecognizedProvider && !hasSyntheticApp && !hasUiResource) {
    return [parseAsString(result), undefined];
  }

  const content = result?.content ?? [];
  if (!content.length && !hasSyntheticApp) {
    return ['(No response)', undefined];
  }

  const imageUrls: t.FormattedContent[] = [];
  const uiResources: UIResource[] = [];
  let placementMarkerCount = 0;
  // Assistants submits only this string; keep its bounded conversion independent from host UI data.
  let currentTextBlock = isRecognizedProvider ? '' : parseAsString(result);

  type ContentHandler = undefined | ((item: t.ToolContentPart) => void);

  const appendTextBlock = (text: string): void => {
    currentTextBlock += (currentTextBlock ? '\n\n' : '') + text;
  };

  const collectImage = (item: t.ImageContent): void => {
    assertImageDataWithinLimit(item);
    const formatter = imageFormatters.default as t.ImageFormatter;
    const formattedImage = formatter(item);
    if (formattedImage.type === 'image_url') {
      imageUrls.push(formattedImage);
    }
  };

  const contentHandlers: {
    text: (item: Extract<t.ToolContentPart, { type: 'text' }>) => void;
    image: (item: t.ToolContentPart) => void;
    resource: (item: Extract<t.ToolContentPart, { type: 'resource' }>) => void;
    resource_link: (item: t.ResourceLink) => void;
  } = {
    text: (item) => {
      if (isRecognizedProvider) {
        appendTextBlock(item.text);
      }
    },

    image: (item) => {
      if (!isRecognizedProvider || !isImageContent(item)) {
        return;
      }
      collectImage(item);
    },

    resource: (item) => {
      const isDeclaredEcho = hasSyntheticApp && item.resource.uri === metadata?.resourceUri;
      const resourceText: string[] = [];
      const inlineText =
        'text' in item.resource && typeof item.resource.text === 'string' ? item.resource.text : '';
      // App-profile documents are resolved separately from the tool result. Plain HTML remains on
      // the legacy renderer, except for an echo of the declared App URI which would duplicate it.
      const isRenderableResource = isRenderableUiResource(item);
      const isLegacyResource =
        mcpApps.legacyHtmlEnabled &&
        isRenderableResource &&
        !isMcpAppMimeType(item.resource.mimeType);
      // Custom clients consume non-HTML UI attachments by marker; MIME/policy still own rendering.
      const isCoreUiResource =
        isUiResource(item) && !isRenderableResource && !isMcpAppMimeType(item.resource.mimeType);
      const hasInlineBody =
        !!inlineText ||
        ('blob' in item.resource && typeof item.resource.blob === 'string' && !!item.resource.blob);
      const shouldTransportUiResource =
        hasInlineBody && (isCoreUiResource || (isLegacyResource && !isDeclaredEcho));

      if (shouldTransportUiResource) {
        // Distinct URIs must not collide into one resourceId even when their markup is identical:
        // the client indexes conversation resources by id, so the second would overwrite the first.
        const baseHash = `${item.resource.uri}\x00${inlineText}`;
        const resourceId = deriveResourceId(
          baseHash,
          result,
          metadata?.toolArgs,
          undefined,
          undefined,
        );
        const uiResource: UIResource = {
          ...item.resource,
          ...(isLegacyResource
            ? { mimeType: resolveMCPUIResourceMimeType(item.resource.mimeType) }
            : {}),
          resourceId,
        };
        uiResources.push(uiResource);
        placementMarkerCount += 1;
        const placementReference =
          `UI Resource ID: ${resourceId}\n` + `UI Resource Marker: \\ui{${resourceId}}`;
        if (isRecognizedProvider) {
          resourceText.push(placementReference);
        } else {
          appendTextBlock(placementReference);
        }

        // A non-HTML ui:// image remains an ordinary image result as well as core UI transport.
        if (isRecognizedProvider && isCoreUiResource) {
          const body = readResourceBody(item.resource);
          if (body.image) {
            collectImage(body.image);
          }
        }
      } else if (isRecognizedProvider && !isRenderableResource) {
        const body = readResourceBody(item.resource);
        if (body.text) {
          resourceText.push(`Resource Text: ${body.text}`);
        } else if (body.image) {
          collectImage(body.image);
        } else if (body.binaryBytes != null) {
          resourceText.push(describeBinaryResource(body.binaryBytes));
        }
      }

      if (isRecognizedProvider && item.resource.uri.length) {
        resourceText.push(`Resource URI: ${flattenMetadata(item.resource.uri)}`);
      }
      if (isRecognizedProvider && item.resource.mimeType != null && item.resource.mimeType) {
        resourceText.push(`Resource MIME Type: ${flattenMetadata(item.resource.mimeType)}`);
      }

      if (resourceText.length) {
        appendTextBlock(resourceText.join('\n'));
      }
    },

    resource_link: (item) => {
      if (!isRecognizedProvider) {
        return;
      }
      const lines = describeResourceLink(item);
      if (lines.length) {
        appendTextBlock(lines.join('\n'));
      }
    },
  };

  for (const item of content) {
    const handler = contentHandlers[item.type as keyof typeof contentHandlers] as ContentHandler;
    if (handler) {
      handler(item as never);
    } else if (isRecognizedProvider) {
      const stringified = JSON.stringify(item, null, 2);
      appendTextBlock(stringified);
    }
  }

  // The declared App document is acquired through resources/read and passed separately. Persistence
  // admission can discard its body while retaining the bound URI descriptor for a later read.
  if (
    hasSyntheticApp &&
    mcpApps.enabled &&
    metadata?.resourceUri &&
    metadata.serverName &&
    metadata.toolName &&
    metadata.serverBinding
  ) {
    const resolvedResource =
      metadata.resolvedAppResource?.uri === metadata.resourceUri &&
      isMcpAppMimeType(metadata.resolvedAppResource.mimeType) &&
      hasUsableAppBody(metadata.resolvedAppResource)
        ? metadata.resolvedAppResource
        : undefined;
    let resolvedBody = '';
    if (resolvedResource && 'text' in resolvedResource) {
      resolvedBody = resolvedResource.text;
    } else if (resolvedResource && 'blob' in resolvedResource) {
      resolvedBody = resolvedResource.blob;
    }
    const itemUi = (resolvedResource?._meta as { ui?: Record<string, unknown> } | undefined)?.ui as
      | { csp?: UIResource['csp']; permissions?: UIResource['permissions'] }
      | undefined;
    const snapshot = {
      uri: metadata.resourceUri,
      mimeType: resolvedResource?.mimeType ?? MCP_APP_MIME_TYPE,
      serverName: metadata.serverName,
      serverBinding: metadata.serverBinding,
      toolName: metadata.toolName,
      structuredContent: result?.structuredContent,
      content: result?.content,
      toolArgs: metadata.toolArgs,
      isError: result?.isError,
      resultMeta: (result as { _meta?: Record<string, unknown> })?._meta,
    };
    const fullResource: UIResource = {
      ...resolvedResource,
      ...snapshot,
      resourceId: deriveResourceId(
        `${metadata.resourceUri}\x00${resolvedBody}`,
        result,
        metadata.toolArgs,
        metadata.serverName,
        metadata.toolName,
      ),
      csp: itemUi?.csp,
      permissions: itemUi?.permissions,
    };
    const maxBytes = mcpApps.maxPersistedAppBytes ?? DEFAULT_MCP_APP_PERSISTED_BYTES;
    if (fitsPersistedAppLimit(fullResource, maxBytes)) {
      uiResources.push(fullResource);
    } else {
      const uriResource: UIResource = {
        ...snapshot,
        resourceId: deriveResourceId(
          `${metadata.resourceUri}\x00`,
          result,
          metadata.toolArgs,
          metadata.serverName,
          metadata.toolName,
        ),
      };
      if (fitsPersistedAppLimit(uriResource, maxBytes)) {
        uiResources.push(uriResource);
      }
    }
  }

  if (placementMarkerCount > 0) {
    const uiInstructions = `

UI Resource Markers Available:
- Each resource above includes a stable ID and a marker hint like \`\\ui{abc123}\`
- You should usually introduce what you're showing before placing the marker
- For a single resource: \\ui{resource-id}
- For multiple resources shown separately: \\ui{resource-id-a} \\ui{resource-id-b}
- For multiple resources in a carousel: \\ui{resource-id-a,resource-id-b,resource-id-c}
- The UI will be rendered inline where you place the marker
- Format: \\ui{resource-id} or \\ui{id1,id2,id3} using the IDs provided above`;

    currentTextBlock += uiInstructions;
  }

  let artifacts: t.Artifacts = undefined;
  if (imageUrls.length > 0) {
    artifacts = { content: imageUrls };
  }

  if (uiResources.length > 0) {
    artifacts = {
      ...artifacts,
      [Tools.ui_resources]: { data: uiResources },
    };
  }

  return [currentTextBlock || (artifacts !== undefined ? '' : '(No response)'), artifacts];
}
