import {
  asElicitationFlowManager,
  extractUrlElicitation,
  generateElicitationFlowId,
  isHttpUrl,
  parseElicitationFlowId,
} from '~/mcp/elicitation';

describe('elicitation flow IDs', () => {
  it('round-trips the userId, serverName, and toolName it was built from', () => {
    const flowId = generateElicitationFlowId('user-1', 'jira_server', 'create_issue');

    expect(parseElicitationFlowId(flowId)).toEqual({
      userId: 'user-1',
      serverName: 'jira_server',
      toolName: 'create_issue',
      nonce: expect.any(String),
      tenantId: undefined,
    });
  });

  it('preserves a colon inside a segment instead of skewing the parsed fields', () => {
    const flowId = generateElicitationFlowId('user-1', 'ns:jira', 'do:thing');
    const parsed = parseElicitationFlowId(flowId);

    expect(parsed?.serverName).toBe('ns:jira');
    expect(parsed?.toolName).toBe('do:thing');
    expect(parsed?.userId).toBe('user-1');
  });

  it('round-trips the tenantId for tenant-scoped flows', () => {
    const flowId = generateElicitationFlowId('user-1', 'jira_server', 'create_issue', 'acme:eu');
    const parsed = parseElicitationFlowId(flowId);

    expect(parsed?.tenantId).toBe('acme:eu');
    expect(parsed?.serverName).toBe('jira_server');
  });

  it('generates a distinct ID per invocation so concurrent calls never collide', () => {
    const a = generateElicitationFlowId('user-1', 'jira_server', 'create_issue');
    const b = generateElicitationFlowId('user-1', 'jira_server', 'create_issue');

    expect(a).not.toBe(b);
  });

  it('returns null for IDs with too few segments', () => {
    expect(parseElicitationFlowId('user-1:jira_server')).toBeNull();
    expect(parseElicitationFlowId('tenant:acme:user-1')).toBeNull();
  });
});

describe('asElicitationFlowManager', () => {
  it('re-views the same manager instance without copying it', () => {
    const manager = { createFlow: jest.fn(), completeFlow: jest.fn() };

    expect(asElicitationFlowManager(manager)).toBe(manager);
  });
});

describe('extractUrlElicitation', () => {
  const elicitation = {
    mode: 'url',
    message: 'Please authorize access to github',
    url: 'https://bedrock-agentcore.eu-west-1.amazonaws.com/identities/oauth2/authorize?request_uri=abc',
    elicitationId: '8cd9f2ba-103d-44c9-8471-6dd02df67c1b',
  };

  it('extracts from a protocol-level McpError shape (code -32042 + data)', () => {
    const error = { code: -32042, data: { elicitations: [elicitation] } };
    expect(extractUrlElicitation(error)).toEqual(elicitation);
  });

  it('extracts from a gateway HTTP-wrapped transport error (the AgentCore wire shape)', () => {
    // Exact shape observed live: gateway returns JSON-RPC errors with a non-2xx
    // HTTP status, so the SDK throws a StreamableHTTPError whose message embeds
    // the raw body and whose `code` is the HTTP status, not -32042.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      error: {
        code: -32042,
        message: 'This request requires authorization.',
        data: { elicitations: [elicitation] },
      },
    });
    const error = Object.assign(
      new Error(`Streamable HTTP error: Error POSTing to endpoint: ${body}`),
      {
        code: 401,
      },
    );
    expect(extractUrlElicitation(error)).toEqual(elicitation);
  });

  it('extracts a whitespaced HTTP-wrapped body (pretty-printed / key-reordered gateway JSON)', () => {
    // A gateway that pretty-prints yields `"code": -32042` (note the space) and
    // may order keys differently; a literal `"code":-32042` substring match would
    // miss it, so extraction must tolerate JSON formatting variance.
    const body = JSON.stringify(
      {
        jsonrpc: '2.0',
        id: 9,
        error: {
          message: 'This request requires authorization.',
          data: { elicitations: [elicitation] },
          code: -32042,
        },
      },
      null,
      2,
    );
    const error = Object.assign(
      new Error(`Streamable HTTP error: Error POSTing to endpoint: ${body}`),
      { code: 401 },
    );
    expect(extractUrlElicitation(error)).toEqual(elicitation);
  });

  it('returns null for non-elicitation errors in both shapes', () => {
    expect(extractUrlElicitation(new Error('boom'))).toBeNull();
    expect(extractUrlElicitation({ code: -32600, data: {} })).toBeNull();
    expect(
      extractUrlElicitation(
        new Error(
          'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":2,"error":{"code":-32600,"message":"Session not initialized"}}',
        ),
      ),
    ).toBeNull();
    expect(extractUrlElicitation(null)).toBeNull();
  });

  it('returns null for a -32042 mention with an unparseable body', () => {
    expect(
      extractUrlElicitation(new Error('Error POSTing to endpoint: {"code":-32042, truncated')),
    ).toBeNull();
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox'])(
    'drops a protocol-level elicitation carrying a hostile-scheme URL (%s)',
    (url) => {
      const error = { code: -32042, data: { elicitations: [{ ...elicitation, url }] } };
      expect(extractUrlElicitation(error)).toBeNull();
    },
  );

  it.each([
    ['missing message', { url: 'https://auth.example.com' }],
    ['non-string message', { url: 'https://auth.example.com', message: { text: 'auth' } }],
    ['blank message', { url: 'https://auth.example.com', message: '   ' }],
    ['non-string url', { message: 'Authorize', url: { href: 'https://auth.example.com' } }],
  ])(
    'drops a malformed elicitation rather than surfacing it half-formed (%s)',
    (_label, malformed) => {
      // `message` and `url` are interpolated straight into user-facing strings,
      // so a malformed payload would render "undefined" in the card.
      const error = { code: -32042, data: { elicitations: [malformed] } };
      expect(extractUrlElicitation(error)).toBeNull();
    },
  );

  it('omits a non-string elicitationId instead of passing it through', () => {
    const error = {
      code: -32042,
      data: {
        elicitations: [{ message: 'Authorize', url: 'https://auth.example.com', elicitationId: 7 }],
      },
    };
    expect(extractUrlElicitation(error)).toEqual({
      message: 'Authorize',
      url: 'https://auth.example.com',
    });
  });

  it.each(['javascript:alert(1)', 'data:text/html,pwn', 'vbscript:msgbox'])(
    'drops an HTTP-wrapped gateway elicitation carrying a hostile-scheme URL (%s)',
    (url) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        error: { code: -32042, message: 'auth', data: { elicitations: [{ ...elicitation, url }] } },
      });
      const error = Object.assign(
        new Error(`Streamable HTTP error: Error POSTing to endpoint: ${body}`),
        { code: 401 },
      );
      expect(extractUrlElicitation(error)).toBeNull();
    },
  );
});

describe('isHttpUrl', () => {
  it.each(['https://auth.example.com/authorize', 'http://localhost:3000/callback'])(
    'accepts http(s) URLs (%s)',
    (url) => {
      expect(isHttpUrl(url)).toBe(true);
    },
  );

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    'file:///etc/passwd',
    'not a url',
    '',
  ])('rejects non-http(s) or unparseable URLs (%s)', (url) => {
    expect(isHttpUrl(url)).toBe(false);
  });
});
