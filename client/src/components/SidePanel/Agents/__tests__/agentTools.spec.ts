import { mergeDirtyToolsWithServerActions } from '../agentTools';

describe('mergeDirtyToolsWithServerActions', () => {
  it('preserves dirty non-action choices and replaces action registrations', () => {
    expect(
      mergeDirtyToolsWithServerActions(
        ['local_plugin', 'removed_action_old---example---com'],
        ['server_plugin', 'added_action_new---example---com'],
      ),
    ).toEqual(['local_plugin', 'added_action_new---example---com']);
  });

  it('does not duplicate a server action registration', () => {
    expect(
      mergeDirtyToolsWithServerActions(
        [],
        ['get_action_api---example---com', 'get_action_api---example---com'],
      ),
    ).toEqual(['get_action_api---example---com']);
  });
});
