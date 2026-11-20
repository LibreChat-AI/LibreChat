import { expect, test } from '@playwright/test';
import { getPrimaryE2EUser } from '../../../setup/users.mock';

/**
 * The client bounds MCP App operations by what the authenticated startup config
 * publishes, so a deployment's `mcpAppSandbox.operationLimits` must reach it,
 * merged over the defaults for the fields the deployment leaves out. The harness
 * configures only `timeoutMs`, above its default, and the other two fields come
 * from the defaults.
 */

test.describe('MCP App operation limits', () => {
  test('the startup config publishes the deployment operation limits @scenario:mcp-app-operation-limits-published', async ({
    request,
  }) => {
    const { email, password } = getPrimaryE2EUser();
    const login = await request.post('/api/auth/login', { data: { email, password } });
    expect(login.ok()).toBeTruthy();
    const { token } = (await login.json()) as { token: string };

    const response = await request.get('/api/config', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.ok()).toBeTruthy();
    const config = (await response.json()) as {
      mcpApps?: { operationLimits?: { maxBytes: number; timeoutMs: number; maxActive: number } };
    };
    expect(config.mcpApps?.operationLimits).toEqual({
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 45000,
      maxActive: 16,
    });
  });
});
