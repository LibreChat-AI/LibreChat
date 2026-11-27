import { Tools } from 'librechat-data-provider';
import type { TAttachment, UIResource } from 'librechat-data-provider';
import {
  getResourceKey,
  hasAppResource,
  isMcpAppResource,
  selectToolCallUIResources,
} from '../apps';

const APP = 'text/html;profile=mcp-app';

const resource = (uri: string, overrides: Partial<UIResource> = {}): UIResource =>
  ({ uri, mimeType: APP, toolName: 'show', serverName: 'server', ...overrides }) as UIResource;

const attachment = (toolCallId: string, resources: UIResource[], scope = {}): TAttachment =>
  ({
    toolCallId,
    type: Tools.ui_resources,
    [Tools.ui_resources]: resources,
    ...scope,
  }) as unknown as TAttachment;

describe('isMcpAppResource', () => {
  it('needs a server, a tool and the MCP Apps profile', () => {
    expect(isMcpAppResource(resource('ui://a'))).toBe(true);
    expect(isMcpAppResource(resource('ui://a', { mimeType: 'text/html' }))).toBe(false);
    expect(isMcpAppResource(resource('ui://a', { toolName: undefined }))).toBe(false);
    expect(isMcpAppResource(resource('ui://a', { serverName: undefined }))).toBe(false);
  });
});

describe('getResourceKey', () => {
  it('prefers the resource id over the uri', () => {
    expect(getResourceKey(resource('ui://a'))).toBe('ui://a');
    expect(getResourceKey(resource('ui://a', { resourceId: 'res_1' }))).toBe('res_1');
  });
});

describe('hasAppResource', () => {
  it('is true only for a ui_resources attachment holding at least one MCP App', () => {
    expect(hasAppResource(attachment('call_0', [resource('ui://a')]))).toBe(true);
    expect(
      hasAppResource(attachment('call_0', [resource('ui://a', { mimeType: 'text/html' })])),
    ).toBe(false);
    expect(hasAppResource(attachment('call_0', []))).toBe(false);
    expect(
      hasAppResource({ toolCallId: 'call_0', filepath: '/a.png' } as unknown as TAttachment),
    ).toBe(false);
    expect(
      hasAppResource({
        type: Tools.ui_resources,
        [Tools.ui_resources]: 'broken',
      } as unknown as TAttachment),
    ).toBe(false);
  });

  it('agrees with the selection for every attachment', () => {
    const attachments = [
      attachment('call_0', [resource('ui://a'), resource('ui://b', { mimeType: 'text/html' })]),
      attachment('call_1', [resource('ui://c', { toolName: undefined })]),
      { toolCallId: 'call_2', filepath: '/a.png' } as unknown as TAttachment,
    ];
    for (const item of attachments) {
      expect(hasAppResource(item)).toBe(selectToolCallUIResources([item]).length > 0);
    }
  });
});

describe('selectToolCallUIResources', () => {
  it('keeps MCP Apps in order and numbers a repeat of the same resource under the same owner', () => {
    const first = attachment('call_0', [
      resource('ui://a'),
      resource('ui://plain', { mimeType: 'text/html' }),
    ]);
    const repeat = attachment('call_0', [resource('ui://a')]);
    const other = attachment('call_0', [resource('ui://a')], { agentId: 'agent_b' });
    const selected = selectToolCallUIResources([first, repeat, other]);

    expect(selected.map((entry) => entry.attachment)).toEqual([first, repeat, other]);
    expect(new Set(selected.map((entry) => entry.key)).size).toBe(3);
    expect(JSON.parse(selected[0].key)[1]).toBe(0);
    expect(JSON.parse(selected[1].key)[1]).toBe(1);
    expect(JSON.parse(selected[2].key)[1]).toBe(0);
    expect(selectToolCallUIResources()).toEqual([]);
  });
});
