import { expect, test } from '@playwright/test';
import { ToolMessage } from '@librechat/agents/langchain/messages';
import { projectArtifactPayload, projectAnthropicArtifactContent } from '@librechat/agents';
import type { Provider } from '../../../../packages/api/src/mcp/types';
import { getImageAttachmentContent } from '../../../../packages/api/src/files/resize';
import { formatToolContent } from '../../../../packages/api/src/mcp/parsers';

test('unknown-provider MCP images remain displayable without vision input @scenario:mcp-unknown-display-images', () => {
  const [content, artifact] = formatToolContent(
    { content: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }] },
    'vertexai' as Provider,
  );
  expect(artifact).toBeDefined();
  if (!artifact) {
    throw new Error('Missing image artifact');
  }
  expect(getImageAttachmentContent(artifact)).toEqual([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  ]);
  const message = new ToolMessage({ content, artifact, tool_call_id: 'image-call' });
  for (const project of [projectArtifactPayload, projectAnthropicArtifactContent]) {
    const projected = project([message]);
    expect(projected).toHaveLength(1);
    expect(projected[0].content).toBe(content);
  }
});
