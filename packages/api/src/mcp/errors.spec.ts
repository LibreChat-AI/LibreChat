import { ErrorEvent } from 'eventsource';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  MCPApiKeyReentryRequiredError,
  getMCPErrorResponse,
  isMCPTransportAuthenticationError,
  MCPTransportAuthenticationError,
  isMCPInitializationError,
} from './errors';
import { OboTokenResolutionError } from './oauth/obo';

describe('MCP initialization propagation', () => {
  it.each([
    new DOMException('Stopped', 'AbortError'),
    new OboTokenResolutionError('session_refresh_failed', 'Retry later', true),
    new OboTokenResolutionError('session_refresh_failed', 'Sign in', false),
  ])('propagates cancellation and typed credential failures: %s', (error) => {
    const controller = new AbortController();
    controller.abort(error);
    expect(isMCPInitializationError(error, controller.signal)).toBe(true);
  });
  it('does not confuse a dependency abort with cancellation of a live run', () => {
    expect(
      isMCPInitializationError(
        new DOMException('timeout', 'AbortError'),
        new AbortController().signal,
      ),
    ).toBe(false);
  });
  it('keeps unrelated optional-tool failures eligible for fallback', () => {
    expect(isMCPInitializationError(new Error('optional tool unavailable'))).toBe(false);
  });
});

describe('direct bearer transport rejection classification', () => {
  it.each([
    new StreamableHTTPError(401, 'unauthorized'),
    new SseError(403, 'forbidden', new ErrorEvent('error')),
    new UnauthorizedError(),
    new MCPTransportAuthenticationError(401),
  ])('recognizes a structured SDK or HTTP rejection: %s', (error) => {
    expect(isMCPTransportAuthenticationError(error)).toBe(true);
  });

  it.each([
    new McpError(ErrorCode.InternalError, 'downstream HTTP 401 invalid_token'),
    new McpError(401, 'invalid_token'),
    new Error('HTTP 401 invalid_token'),
    new StreamableHTTPError(500, 'downstream HTTP 401'),
  ])('does not infer transport rejection from tool codes or messages: %s', (error) => {
    expect(isMCPTransportAuthenticationError(error)).toBe(false);
  });
});

describe('MCP HTTP error response mapping', () => {
  it('maps API key rebinding errors without exposing credential material', () => {
    expect(getMCPErrorResponse(new MCPApiKeyReentryRequiredError(['url']))).toEqual({
      statusCode: 400,
      body: {
        error: 'MCP_API_KEY_REENTRY_REQUIRED',
        message: 'Re-enter apiKey.key when changing API key credential binding fields: url',
      },
    });
  });

  it('preserves legacy domain error behavior', () => {
    expect(getMCPErrorResponse(new Error('MCP_DOMAIN_NOT_ALLOWED: blocked.example.com'))).toEqual({
      statusCode: 403,
      body: {
        error: 'MCP_DOMAIN_NOT_ALLOWED',
        message: 'blocked.example.com',
      },
    });
  });

  it('ignores unrelated errors', () => {
    expect(getMCPErrorResponse(new Error('unrelated'))).toBeNull();
  });
});
