import {
  Constants,
  splitMCPToolKey,
  splitToolCallName,
  normalizeMCPToolKey,
  buildServerNameAliases,
  stripServerNamePrefix,
  stripServerNamePrefixes,
} from './config';

describe('splitMCPToolKey', () => {
  it('splits a normal single-delimiter key like String.split would', () => {
    expect(splitMCPToolKey('search_mcp_myserver')).toEqual(['search', 'myserver']);
  });

  it('returns an undefined server name when there is no delimiter', () => {
    expect(splitMCPToolKey('plainToolName')).toEqual(['plainToolName', undefined]);
  });

  it('resolves a raw tool name containing the delimiter via the last occurrence', () => {
    expect(splitMCPToolKey('gitlab-get_mcp_server_version_mcp_gitlab')).toEqual([
      'gitlab-get_mcp_server_version',
      'gitlab',
    ]);
  });

  it('resolves a server name containing the delimiter when known names are supplied', () => {
    expect(splitMCPToolKey('search_mcp_Google_mcp_Workspace', ['Google_mcp_Workspace'])).toEqual([
      'search',
      'Google_mcp_Workspace',
    ]);
  });

  it('prefers the longest matching configured server name', () => {
    expect(
      splitMCPToolKey('search_mcp_Google_mcp_Workspace', ['Workspace', 'Google_mcp_Workspace']),
    ).toEqual(['search', 'Google_mcp_Workspace']);
  });

  it('falls back to the last delimiter when no configured name matches', () => {
    expect(splitMCPToolKey('gitlab-get_mcp_server_version_mcp_gitlab', ['other'])).toEqual([
      'gitlab-get_mcp_server_version',
      'gitlab',
    ]);
  });

  it('still resolves the tool half when both halves contain the delimiter', () => {
    expect(splitMCPToolKey('a_mcp_b_mcp_Google_mcp_Workspace', ['Google_mcp_Workspace'])).toEqual([
      'a_mcp_b',
      'Google_mcp_Workspace',
    ]);
  });
});

describe('splitToolCallName', () => {
  const d = Constants.mcp_delimiter;

  it('treats a synthetic OAuth call as oauth plus the full server name', () => {
    expect(splitToolCallName(`oauth${d}foo${d}bar`)).toEqual(['oauth', `foo${d}bar`]);
  });

  it('keeps a normalized server name that itself contains the delimiter', () => {
    expect(splitToolCallName(`oauth${d}oauth${d}server`)).toEqual(['oauth', `oauth${d}server`]);
  });

  it('resolves a real tool key whose raw name contains the delimiter', () => {
    expect(splitToolCallName(`gitlab-get${d}server_version${d}gitlab`)).toEqual([
      `gitlab-get${d}server_version`,
      'gitlab',
    ]);
  });

  it('resolves a real tool key against configured server names when supplied', () => {
    expect(splitToolCallName(`search${d}Google${d}Workspace`, [`Google${d}Workspace`])).toEqual([
      'search',
      `Google${d}Workspace`,
    ]);
  });
});

describe('splitToolCallName with configured server names', () => {
  const d = Constants.mcp_delimiter;

  it('reads a real tool whose own name starts with the oauth prefix', () => {
    expect(splitToolCallName(`oauth${d}reset${d}github`, ['github'])).toEqual([
      `oauth${d}reset`,
      'github',
    ]);
  });

  it('still resolves a synthetic OAuth call for a configured server', () => {
    expect(splitToolCallName(`oauth${d}github`, ['github'])).toEqual(['oauth', 'github']);
  });

  it('resolves a synthetic OAuth call for a delimiter-bearing configured server', () => {
    expect(splitToolCallName(`oauth${d}foo${d}bar`, [`foo${d}bar`])).toEqual([
      'oauth',
      `foo${d}bar`,
    ]);
  });
});

describe('splitMCPToolKey boundary alignment', () => {
  const d = Constants.mcp_delimiter;

  it('ignores a configured name that is not delimiter-aligned in the key', () => {
    /** `server` is a bare suffix of `myserver`, not a segment. Matching on
     *  `endsWith(name)` instead of `endsWith(delimiter + name)` would route the
     *  call to a different configured server than the agent authorized. */
    expect(splitMCPToolKey(`search${d}myserver`, ['server'])).toEqual(['search', 'myserver']);
  });

  it('treats an empty known-name list the same as no list', () => {
    expect(splitMCPToolKey(`gitlab-get${d}server_version${d}gitlab`, [])).toEqual([
      `gitlab-get${d}server_version`,
      'gitlab',
    ]);
  });

  it('requires the configured name to be normalized to match the key', () => {
    /** Keys embed `normalizeServerName`'s output, so callers must normalize their
     *  candidate list; a raw name with spaces can never align. */
    expect(splitMCPToolKey(`search${d}Google_mcp_Workspace`, ['Google_mcp_Workspace'])).toEqual([
      'search',
      'Google_mcp_Workspace',
    ]);
  });
});

describe('buildServerNameAliases', () => {
  it('maps normalized forms back to raw config names, including identity entries', () => {
    const aliases = buildServerNameAliases(['plain', 'Connector: Company']);
    expect(aliases.get('plain')).toBe('plain');
    expect(aliases.get('Connector__Company')).toBe('Connector: Company');
    expect(aliases.get('Connector: Company')).toBeUndefined();
  });

  it('skips empty names', () => {
    expect(buildServerNameAliases(['', 'srv']).size).toBe(1);
  });

  it('resolves normalized-name collisions to the FIRST configured name deterministically', () => {
    /** `Sales Force` and `Sales:Force` both normalize to `Sales_Force`; their
     *  tool keys are inherently ambiguous, so routing must at least be stable
     *  (the collision itself is warned about at context resolution). */
    const aliases = buildServerNameAliases(['Sales Force', 'Sales:Force']);
    expect(aliases.get('Sales_Force')).toBe('Sales Force');
  });

  it('an identity name owns its slot regardless of configuration order', () => {
    /** A server literally named `Sales_Force` must never have its keys
     *  rerouted to a special-character server that normalizes onto it. */
    expect(buildServerNameAliases(['Sales Force', 'Sales_Force']).get('Sales_Force')).toBe(
      'Sales_Force',
    );
    expect(buildServerNameAliases(['Sales_Force', 'Sales Force']).get('Sales_Force')).toBe(
      'Sales_Force',
    );
  });
});

describe('normalizeMCPToolKey', () => {
  const d = Constants.mcp_delimiter;

  it('rewrites the server segment of a raw-keyed tool to its normalized form', () => {
    expect(normalizeMCPToolKey(`search${d}Connector: Company`, ['Connector: Company'])).toBe(
      `search${d}Connector__Company`,
    );
  });

  it('is a no-op for already-normalized keys and safe server names', () => {
    expect(normalizeMCPToolKey(`search${d}Connector__Company`, ['Connector: Company'])).toBe(
      `search${d}Connector__Company`,
    );
    expect(normalizeMCPToolKey(`search${d}plain`, ['plain'])).toBe(`search${d}plain`);
  });

  it('is a no-op when no configured raw name matches (unconfigured or non-MCP keys)', () => {
    expect(normalizeMCPToolKey(`search${d}gone server`, ['Connector: Company'])).toBe(
      `search${d}gone server`,
    );
    expect(normalizeMCPToolKey('web_search', ['Connector: Company'])).toBe('web_search');
  });

  it('resolves the boundary by longest raw match, preserving delimiter-bearing tool names', () => {
    /** The tool half may itself contain the delimiter (gateway-prefixed names). */
    expect(normalizeMCPToolKey(`gitlab-get${d}server_version${d}My Server`, ['My Server'])).toBe(
      `gitlab-get${d}server_version${d}My_Server`,
    );
    /** `normalizeServerName` strips the trailing `_` it substitutes for `!`. */
    expect(normalizeMCPToolKey(`search${d}My${d}Server!`, ['Server!', `My${d}Server!`])).toBe(
      `search${d}My${d}Server`,
    );
  });
});

describe('splitToolCallName oauth precedence', () => {
  const d = Constants.mcp_delimiter;

  it('falls back to the oauth prefix when a list is supplied but nothing matches', () => {
    /** Pins the precedence rule: the configured branch must not return its
     *  last-delimiter result when no configured name actually matched. */
    expect(splitToolCallName(`oauth${d}foo${d}bar`, ['github'])).toEqual(['oauth', `foo${d}bar`]);
  });

  it('prefers a matching configured server over the oauth prefix', () => {
    expect(splitToolCallName(`oauth${d}reset${d}github`, ['github'])).toEqual([
      `oauth${d}reset`,
      'github',
    ]);
  });
});

describe('stripServerNamePrefix', () => {
  it('strips a leading server-name prefix from the tool name', () => {
    expect(stripServerNamePrefix('acme_trace_top_time_consuming_operations', 'acme')).toBe(
      'trace_top_time_consuming_operations',
    );
  });

  it('matches the prefix case-insensitively', () => {
    /** Display-cased server names ("Acme") conventionally prefix their
     *  tools in lowercase — the redundancy is the same either way. */
    expect(stripServerNamePrefix('acme_list_services', 'Acme')).toBe('list_services');
  });

  it('returns the name unchanged when the prefix does not match', () => {
    expect(stripServerNamePrefix('github_create_issue', 'acme')).toBe('github_create_issue');
  });

  it('requires the underscore separator, not a bare substring match', () => {
    expect(stripServerNamePrefix('acmecorp_tool', 'acme')).toBe('acmecorp_tool');
  });

  it('keeps a name that is exactly the server name or would strip to empty', () => {
    expect(stripServerNamePrefix('acme', 'acme')).toBe('acme');
    expect(stripServerNamePrefix('acme_', 'acme')).toBe('acme_');
  });
});

describe('stripServerNamePrefixes', () => {
  it('maps every raw name to its stripped model-facing name', () => {
    const map = stripServerNamePrefixes(['acme_search', 'list_services'], 'acme');
    expect(map.get('acme_search')).toBe('search');
    expect(map.get('list_services')).toBe('list_services');
  });

  it('keeps the prefixed name when stripping would collide with a bare sibling', () => {
    /** A server exposing BOTH `search` and `acme_search` must keep two
     *  distinct keys — stripping would collapse them into one. */
    const map = stripServerNamePrefixes(['search', 'acme_search'], 'acme');
    expect(map.get('search')).toBe('search');
    expect(map.get('acme_search')).toBe('acme_search');
  });

  it('keeps both raw names when case-variant prefixed siblings strip to the same result', () => {
    /** The prefix match is case-insensitive, so `acme_Foo` and `Acme_Foo` are
     *  distinct upstream tools with the SAME stripped remainder — both must
     *  fall back to their raw names or one silently overwrites the other. */
    const map = stripServerNamePrefixes(['acme_Foo', 'Acme_Foo'], 'acme');
    expect(map.get('acme_Foo')).toBe('acme_Foo');
    expect(map.get('Acme_Foo')).toBe('Acme_Foo');
  });

  it('collisions do not suppress stripping of unrelated siblings', () => {
    const map = stripServerNamePrefixes(['search', 'acme_search', 'acme_trace'], 'acme');
    expect(map.get('acme_trace')).toBe('trace');
  });

  it('reserves every sibling raw name, even when that sibling itself strips', () => {
    /** Keys persisted BEFORE stripping embed raw names: if `acme_acme_foo`
     *  stripped to `acme_foo`, a pre-rollout reference to the REAL `acme_foo`
     *  would exact-match the wrong tool in the same snapshot. */
    const map = stripServerNamePrefixes(['acme_foo', 'acme_acme_foo'], 'acme');
    expect(map.get('acme_foo')).toBe('foo');
    expect(map.get('acme_acme_foo')).toBe('acme_acme_foo');
  });

  it('resolves secondary collisions introduced by a fallback to a raw name', () => {
    /** `acme_foo` falls back to raw because of the bare `foo`, which then
     *  collides with `acme_acme_foo`'s stripped result — the guard must
     *  iterate until no two final names coincide. */
    const map = stripServerNamePrefixes(['foo', 'acme_foo', 'acme_acme_foo'], 'acme');
    expect(map.get('foo')).toBe('foo');
    expect(map.get('acme_foo')).toBe('acme_foo');
    expect(map.get('acme_acme_foo')).toBe('acme_acme_foo');
    expect(new Set(map.values()).size).toBe(3);
  });

  it('never strips a remainder that equals a synthetic MCP marker', () => {
    /** `sys__all__sys` keys expand to every server tool, `sys__server__sys`
     *  keys are skipped as UI placeholders, and `oauth${mcp_delimiter}` names
     *  get OAuth-only handling in the client stream handlers — a real
     *  upstream tool must not be renamed onto any of them. */
    expect(stripServerNamePrefix(`acme_${Constants.mcp_all}`, 'acme')).toBe(
      `acme_${Constants.mcp_all}`,
    );
    expect(stripServerNamePrefix(`acme_${Constants.mcp_server}`, 'acme')).toBe(
      `acme_${Constants.mcp_server}`,
    );
    expect(stripServerNamePrefix('acme_oauth', 'acme')).toBe('acme_oauth');
    /** Each marker is consumed by PREFIX (`isMCPAllPlaceholder`, the
     *  server-pin skip, the client's OAuth classification), so the whole
     *  `${marker}${mcp_delimiter}` namespace stays raw, not just the exact
     *  name. */
    expect(stripServerNamePrefix(`acme_oauth${Constants.mcp_delimiter}reset`, 'acme')).toBe(
      `acme_oauth${Constants.mcp_delimiter}reset`,
    );
    expect(
      stripServerNamePrefix(`acme_${Constants.mcp_all}${Constants.mcp_delimiter}reset`, 'acme'),
    ).toBe(`acme_${Constants.mcp_all}${Constants.mcp_delimiter}reset`);
    expect(
      stripServerNamePrefix(`acme_${Constants.mcp_server}${Constants.mcp_delimiter}reset`, 'acme'),
    ).toBe(`acme_${Constants.mcp_server}${Constants.mcp_delimiter}reset`);
    /** `mcp_` opens the server-scoped pluginKey namespace and
     *  `lc_transfer_to_` the agent-handoff namespace — pre-strip tool keys
     *  could never enter either. */
    expect(stripServerNamePrefix('acme_mcp_status', 'acme')).toBe('acme_mcp_status');
    expect(stripServerNamePrefix('acme_lc_transfer_to_status', 'acme')).toBe(
      'acme_lc_transfer_to_status',
    );
  });

  it('never flips isActionTool classification for the produced key', () => {
    /** `isActionTool` compares the FIRST `_action_` and `_mcp_` positions;
     *  stripping moves `_mcp_` earlier, so a server whose normalized name
     *  contains `_action_` (e.g. "svc action v1") would see a real MCP tool
     *  reclassified as an OpenAPI action and bypass MCP authorization. */
    expect(stripServerNamePrefix('svc_action_v1_report', 'svc_action_v1')).toBe(
      'svc_action_v1_report',
    );
    /** A remainder containing `_action_` in the tool half does not flip and
     *  still strips. */
    expect(stripServerNamePrefix('acme_do_action_thing', 'acme')).toBe('do_action_thing');
  });
});
