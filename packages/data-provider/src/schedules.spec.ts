import { authorizeScheduledObo, inspectScheduledObo } from './data-service';
import * as endpoints from './api-endpoints';
import request from './request';

jest.mock('./request', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

it('submits the previewed endpoint and scopes without resolving a different server', async () => {
  const preview = {
    server: 'Files',
    scopes: 'api://resource/Read',
    url: 'https://mcp.example.test/tools',
    binding: 'opaque-preview-binding',
  };
  jest.mocked(request.get).mockResolvedValue(preview);

  const inspected = await inspectScheduledObo('sched-1', preview.server);
  await authorizeScheduledObo('sched-1', preview.server, inspected.scopes, inspected.binding);

  expect(request.get).toHaveBeenCalledWith(endpoints.scheduledObo('sched-1', 'Files'), {
    signal: undefined,
  });
  expect(request.post).toHaveBeenCalledWith(endpoints.scheduledObo('sched-1', 'Files'), {
    expectedScopes: preview.scopes,
    expectedBinding: preview.binding,
  });
});
