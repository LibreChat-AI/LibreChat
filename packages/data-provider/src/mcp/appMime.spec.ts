import { isHtmlMediaType, isMcpAppMimeType, resolveMCPUIResourceMimeType } from './appMime';

describe('MCP UI media types', () => {
  it.each([
    [undefined, 'text/html'],
    [null, 'text/html'],
    ['', ''],
    ['application/xhtml+xml', 'application/xhtml+xml'],
  ])('normalizes %j to %j', (mimeType, expected) => {
    expect(resolveMCPUIResourceMimeType(mimeType)).toBe(expected);
  });

  it.each([
    ['text/html', true],
    ['Text/HTML', true],
    [' text/html ; charset=utf-8', true],
    ['application/xhtml+xml', false],
    ['', false],
    [undefined, false],
  ])('classifies legacy MIME %j as HTML=%s', (mimeType, expected) => {
    expect(isHtmlMediaType(mimeType)).toBe(expected);
  });

  it('keeps the App profile strict to text/html', () => {
    expect(isMcpAppMimeType('text/html;profile=mcp-app')).toBe(true);
    expect(isMcpAppMimeType('application/xhtml+xml;profile=mcp-app')).toBe(false);
    expect(isMcpAppMimeType(resolveMCPUIResourceMimeType(undefined))).toBe(false);
  });
});
