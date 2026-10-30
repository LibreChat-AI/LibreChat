import { StdioOptionsSchema, SSEOptionsSchema, MCPOptionsSchema } from './mcp';

describe('mcp schema - deferLoading', () => {
  const baseStdio = { command: 'node', args: ['server.js'] };

  it('parses deferLoading: true on a stdio server', () => {
    const result = StdioOptionsSchema.parse({ ...baseStdio, deferLoading: true });
    expect(result.deferLoading).toBe(true);
  });

  it('parses deferLoading: false on a stdio server', () => {
    const result = StdioOptionsSchema.parse({ ...baseStdio, deferLoading: false });
    expect(result.deferLoading).toBe(false);
  });

  it('treats deferLoading as optional (absent -> undefined)', () => {
    const result = StdioOptionsSchema.parse(baseStdio);
    expect(result.deferLoading).toBeUndefined();
  });

  it('rejects a non-boolean deferLoading', () => {
    const result = StdioOptionsSchema.safeParse({ ...baseStdio, deferLoading: 'yes' });
    expect(result.success).toBe(false);
  });

  it('parses deferLoading on a remote (SSE) server', () => {
    const result = SSEOptionsSchema.parse({
      url: 'https://example.com/sse',
      deferLoading: true,
    });
    expect(result.deferLoading).toBe(true);
  });

  it('parses deferLoading through the MCPOptions union', () => {
    const result = MCPOptionsSchema.parse({ ...baseStdio, deferLoading: true });
    expect(result.deferLoading).toBe(true);
  });
});
