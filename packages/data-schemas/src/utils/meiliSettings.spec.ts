import {
  DEFAULT_MEILI_SETTINGS_TIMEOUT_MS,
  mergeFilterableAttributes,
  resolveMeiliSettingsTimeoutMs,
  updateFilterableAttributes,
} from './meiliSettings';

describe('meiliSettings', () => {
  describe('mergeFilterableAttributes', () => {
    it('preserves custom attributes while requiring user and tenantId', () => {
      expect(mergeFilterableAttributes(['customAttribute'])).toEqual([
        'customAttribute',
        'user',
        'tenantId',
      ]);
    });

    it('returns null when required attributes are already configured', () => {
      expect(mergeFilterableAttributes(['user', 'tenantId', 'customAttribute'])).toBeNull();
    });

    it('treats missing settings as empty', () => {
      expect(mergeFilterableAttributes(undefined)).toEqual(['user', 'tenantId']);
    });
  });

  describe('resolveMeiliSettingsTimeoutMs', () => {
    it('uses an explicit override, otherwise the schema default', () => {
      expect(resolveMeiliSettingsTimeoutMs(30_000)).toBe(30_000);
      expect(resolveMeiliSettingsTimeoutMs()).toBe(DEFAULT_MEILI_SETTINGS_TIMEOUT_MS);
    });
  });

  describe('updateFilterableAttributes', () => {
    it('waits for the settings task and rejects non-success statuses', async () => {
      const updateSettings = jest.fn().mockResolvedValue({ taskUid: 7 });
      const waitForTask = jest.fn().mockResolvedValue({ status: 'succeeded' });

      await updateFilterableAttributes({
        client: { waitForTask },
        index: { updateSettings },
        filterableAttributes: ['user', 'tenantId'],
        timeoutMs: 1_000,
      });

      expect(updateSettings).toHaveBeenCalledWith({
        filterableAttributes: ['user', 'tenantId'],
      });
      expect(waitForTask).toHaveBeenCalledWith(7, {
        timeOutMs: 1_000,
        intervalMs: 100,
      });

      waitForTask.mockResolvedValueOnce({ status: 'failed' });
      await expect(
        updateFilterableAttributes({
          client: { waitForTask },
          index: { updateSettings },
          filterableAttributes: ['user'],
          context: '[test]',
        }),
      ).rejects.toThrow('[test] Meili settings task 7 ended with failed');
    });
  });
});
