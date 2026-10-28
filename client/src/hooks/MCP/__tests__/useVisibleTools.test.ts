import { renderHook } from '@testing-library/react';
import { Constants } from 'librechat-data-provider';
import type { TPlugin } from 'librechat-data-provider';
import type { MCPServerInfo } from '~/common';
import { useVisibleTools } from '../useVisibleTools';

const d = Constants.mcp_delimiter;

describe('useVisibleTools', () => {
  const regularTools: TPlugin[] = [{ name: 'Web Search', pluginKey: 'web_search' }] as TPlugin[];
  const mcpServersMap = new Map<string, MCPServerInfo>([
    ['gitlab', {} as MCPServerInfo],
    ['myserver', {} as MCPServerInfo],
  ]);

  it('resolves a normal single-delimiter MCP tool id to its server name', () => {
    const { result } = renderHook(() =>
      useVisibleTools([`search${d}myserver`], regularTools, mcpServersMap),
    );
    expect(result.current.mcpServerNames).toEqual(['myserver']);
    expect(result.current.toolIds).toEqual([]);
  });

  it('resolves an MCP tool id whose raw tool name itself contains the delimiter substring', () => {
    // Regression test for https://github.com/LibreChat-AI/LibreChat/issues/14440:
    // a raw MCP tool name that already contains "_mcp_" (e.g. one exposed
    // through a gateway that prefixes tool names by server) must still
    // resolve to the real server name - the *last* segment, not
    // `.split(delimiter)[1]`, which would grab the wrong (middle) segment
    // once there's more than one occurrence.
    const toolId = `gitlab-get${d}server_version${d}gitlab`;
    const { result } = renderHook(() => useVisibleTools([toolId], regularTools, mcpServersMap));
    expect(result.current.mcpServerNames).toEqual(['gitlab']);
  });

  it('resolves normalized-spelling ids back to the raw server key of the servers map', () => {
    /** Tool ids embed `normalizeServerName(server)` while the servers map is
     *  keyed raw — a special-character server must resolve to its raw map key
     *  instead of surfacing the normalized segment as an unknown orphan. */
    const specialMap = new Map<string, MCPServerInfo>([
      ['Connector: Company', {} as MCPServerInfo],
    ]);
    const { result } = renderHook(() =>
      useVisibleTools([`search${d}Connector__Company`], regularTools, specialMap),
    );
    expect(result.current.mcpServerNames).toEqual(['Connector: Company']);
  });

  it('still resolves legacy raw-spelling ids for a special-character server', () => {
    const specialMap = new Map<string, MCPServerInfo>([
      ['Connector: Company', {} as MCPServerInfo],
    ]);
    const { result } = renderHook(() =>
      useVisibleTools([`search${d}Connector: Company`], regularTools, specialMap),
    );
    expect(result.current.mcpServerNames).toEqual(['Connector: Company']);
  });

  it('keeps regular (non-MCP) tools separate from MCP server names', () => {
    const { result } = renderHook(() =>
      useVisibleTools(['web_search'], regularTools, mcpServersMap),
    );
    expect(result.current.toolIds).toEqual(['web_search']);
    expect(result.current.mcpServerNames).toEqual([]);
  });
});
