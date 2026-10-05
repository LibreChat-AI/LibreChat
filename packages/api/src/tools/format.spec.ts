import { AuthType, EToolResources } from 'librechat-data-provider';
import type { TPlugin } from 'librechat-data-provider';
import { filterUniquePlugins, checkPluginAuth, getToolkitKey } from './format';

describe('format.ts helper functions', () => {
  describe('filterUniquePlugins', () => {
    it('should return empty array when plugins is undefined', () => {
      const result = filterUniquePlugins(undefined);
      expect(result).toEqual([]);
    });

    it('should return empty array when plugins is empty', () => {
      const result = filterUniquePlugins([]);
      expect(result).toEqual([]);
    });

    it('should filter out duplicate plugins based on pluginKey', () => {
      const plugins: TPlugin[] = [
        { name: 'Plugin1', pluginKey: 'key1', description: 'First plugin' },
        { name: 'Plugin2', pluginKey: 'key2', description: 'Second plugin' },
        { name: 'Plugin1 Duplicate', pluginKey: 'key1', description: 'Duplicate of first' },
        { name: 'Plugin3', pluginKey: 'key3', description: 'Third plugin' },
      ];

      const result = filterUniquePlugins(plugins);
      expect(result).toHaveLength(3);
      expect(result[0].pluginKey).toBe('key1');
      expect(result[1].pluginKey).toBe('key2');
      expect(result[2].pluginKey).toBe('key3');
      // The first occurrence should be kept
      expect(result[0].name).toBe('Plugin1');
    });

    it('should handle plugins with identical data', () => {
      const plugin: TPlugin = { name: 'Plugin', pluginKey: 'key', description: 'Test' };
      const plugins: TPlugin[] = [plugin, plugin, plugin];

      const result = filterUniquePlugins(plugins);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(plugin);
    });
  });

  describe('checkPluginAuth', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return false when plugin is undefined', () => {
      const result = checkPluginAuth(undefined);
      expect(result).toBe(false);
    });

    it('should return false when authConfig is undefined', () => {
      const plugin: TPlugin = { name: 'Test', pluginKey: 'test', description: 'Test plugin' };
      const result = checkPluginAuth(plugin);
      expect(result).toBe(false);
    });

    it('should return false when authConfig is empty array', () => {
      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [],
      };
      const result = checkPluginAuth(plugin);
      expect(result).toBe(false);
    });

    it('should return true when all required auth fields have valid env values', () => {
      process.env.API_KEY = 'valid-key';
      process.env.SECRET_KEY = 'valid-secret';

      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [
          { authField: 'API_KEY', label: 'API Key', description: 'API Key' },
          { authField: 'SECRET_KEY', label: 'Secret Key', description: 'Secret Key' },
        ],
      };

      const result = checkPluginAuth(plugin);
      expect(result).toBe(true);
    });

    it('should return false when any required auth field is missing', () => {
      process.env.API_KEY = 'valid-key';
      // SECRET_KEY is not set

      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [
          { authField: 'API_KEY', label: 'API Key', description: 'API Key' },
          { authField: 'SECRET_KEY', label: 'Secret Key', description: 'Secret Key' },
        ],
      };

      const result = checkPluginAuth(plugin);
      expect(result).toBe(false);
    });

    it('should return false when auth field value is empty string', () => {
      process.env.API_KEY = '';

      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [{ authField: 'API_KEY', label: 'API Key', description: 'API Key' }],
      };

      const result = checkPluginAuth(plugin);
      expect(result).toBe(false);
    });

    it('should return false when auth field value is whitespace only', () => {
      process.env.API_KEY = '   ';

      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [{ authField: 'API_KEY', label: 'API Key', description: 'API Key' }],
      };

      const result = checkPluginAuth(plugin);
      expect(result).toBe(false);
    });

    it('should return false when auth field value is USER_PROVIDED', () => {
      process.env.API_KEY = AuthType.USER_PROVIDED;

      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [{ authField: 'API_KEY', label: 'API Key', description: 'API Key' }],
      };

      const result = checkPluginAuth(plugin);
      expect(result).toBe(false);
    });

    it('should handle alternate auth fields with || separator', () => {
      process.env.ALTERNATE_KEY = 'valid-key';

      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [
          { authField: 'PRIMARY_KEY||ALTERNATE_KEY', label: 'API Key', description: 'API Key' },
        ],
      };

      const result = checkPluginAuth(plugin);
      expect(result).toBe(true);
    });

    it('should return true when at least one alternate auth field is valid', () => {
      process.env.PRIMARY_KEY = '';
      process.env.ALTERNATE_KEY = 'valid-key';
      process.env.THIRD_KEY = AuthType.USER_PROVIDED;

      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [
          {
            authField: 'PRIMARY_KEY||ALTERNATE_KEY||THIRD_KEY',
            label: 'API Key',
            description: 'API Key',
          },
        ],
      };

      const result = checkPluginAuth(plugin);
      expect(result).toBe(true);
    });

    it('should return true when auth field is marked as optional with no env vars', () => {
      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [
          { authField: 'MISSING_KEY', label: 'API Key', description: 'API Key', optional: true },
        ],
      };

      const result = checkPluginAuth(plugin);
      expect(result).toBe(true);
    });

    it('should return true when all auth fields are optional', () => {
      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [
          { authField: 'MISSING_KEY_A', label: 'Key A', description: 'Key A', optional: true },
          { authField: 'MISSING_KEY_B', label: 'Key B', description: 'Key B', optional: true },
        ],
      };

      const result = checkPluginAuth(plugin);
      expect(result).toBe(true);
    });

    it('should return false when required field is missing even if optional field exists', () => {
      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [
          { authField: 'MISSING_KEY', label: 'Required Key', description: 'Required' },
          {
            authField: 'OPTIONAL_KEY',
            label: 'Optional Key',
            description: 'Optional',
            optional: true,
          },
        ],
      };

      const result = checkPluginAuth(plugin);
      expect(result).toBe(false);
    });

    it('should return true when optional field has no env var but required field is satisfied', () => {
      process.env.REQUIRED_KEY = 'valid-key';

      const plugin: TPlugin = {
        name: 'Test',
        pluginKey: 'test',
        description: 'Test plugin',
        authConfig: [
          { authField: 'REQUIRED_KEY', label: 'Required Key', description: 'Required' },
          {
            authField: 'OPTIONAL_KEY',
            label: 'Optional Key',
            description: 'Optional',
            optional: true,
          },
        ],
      };

      const result = checkPluginAuth(plugin);
      expect(result).toBe(true);
    });
  });

  describe('getToolkitKey', () => {
    it('resolves a declared child only when its parent toolkit is registered', () => {
      const media: TPlugin = {
        name: 'Media',
        pluginKey: 'media_generate',
        description: 'Media generation and status',
      };
      expect(getToolkitKey({ toolkits: [media], toolName: 'media_status' })).toBe('media_generate');
      expect(getToolkitKey({ toolkits: [], toolName: 'media_status' })).toBeUndefined();
    });
    it('should return undefined when toolName is undefined', () => {
      const toolkits: TPlugin[] = [
        { name: 'Toolkit1', pluginKey: 'toolkit1', description: 'Test toolkit' },
      ];

      const result = getToolkitKey({ toolkits, toolName: undefined });
      expect(result).toBeUndefined();
    });

    it('should return undefined when toolName is empty string', () => {
      const toolkits: TPlugin[] = [
        { name: 'Toolkit1', pluginKey: 'toolkit1', description: 'Test toolkit' },
      ];

      const result = getToolkitKey({ toolkits, toolName: '' });
      expect(result).toBeUndefined();
    });

    it('should return undefined when no matching toolkit is found', () => {
      const toolkits: TPlugin[] = [
        { name: 'Toolkit1', pluginKey: 'toolkit1', description: 'Test toolkit' },
        { name: 'Toolkit2', pluginKey: 'toolkit2', description: 'Test toolkit' },
      ];

      const result = getToolkitKey({ toolkits, toolName: 'nonexistent_tool' });
      expect(result).toBeUndefined();
    });

    it('should match toolkit when toolName starts with pluginKey', () => {
      const toolkits: TPlugin[] = [
        { name: 'Toolkit1', pluginKey: 'toolkit1', description: 'Test toolkit' },
        { name: 'Toolkit2', pluginKey: 'toolkit2', description: 'Test toolkit' },
      ];

      const result = getToolkitKey({ toolkits, toolName: 'toolkit2_function' });
      expect(result).toBe('toolkit2');
    });

    it('should handle image_edit tools with suffix matching', () => {
      const toolkits: TPlugin[] = [
        { name: 'Image Editor', pluginKey: 'image_edit_v1', description: 'Image editing' },
        { name: 'Image Editor 2', pluginKey: 'image_edit_v2', description: 'Image editing v2' },
      ];

      const result = getToolkitKey({
        toolkits,
        toolName: `${EToolResources.image_edit}_function_v2`,
      });
      expect(result).toBe('image_edit_v2');
    });

    it('should match the first toolkit when multiple matches are possible', () => {
      const toolkits: TPlugin[] = [
        { name: 'Toolkit', pluginKey: 'toolkit', description: 'Base toolkit' },
        { name: 'Toolkit Extended', pluginKey: 'toolkit_extended', description: 'Extended' },
      ];

      const result = getToolkitKey({ toolkits, toolName: 'toolkit_function' });
      expect(result).toBe('toolkit');
    });

    it('should handle empty toolkits array', () => {
      const toolkits: TPlugin[] = [];

      const result = getToolkitKey({ toolkits, toolName: 'any_tool' });
      expect(result).toBeUndefined();
    });

    it('should handle complex plugin keys with underscores', () => {
      const toolkits: TPlugin[] = [
        {
          name: 'Complex Toolkit',
          pluginKey: 'complex_toolkit_with_underscores',
          description: 'Complex',
        },
      ];

      const result = getToolkitKey({
        toolkits,
        toolName: 'complex_toolkit_with_underscores_function',
      });
      expect(result).toBe('complex_toolkit_with_underscores');
    });
  });
});
