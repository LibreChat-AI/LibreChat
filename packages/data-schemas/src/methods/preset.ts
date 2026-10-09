import type { Model } from 'mongoose';
import logger from '~/config/winston';

interface IPreset {
  user?: string;
  presetId?: string;
  order?: number;
  defaultPreset?: boolean;
  tools?: (string | { pluginKey?: string })[];
  updatedAt?: Date;
  [key: string]: unknown;
}

export function createPresetMethods(mongoose: typeof import('mongoose')): {
  getPreset: (
    user: string,
    presetId: string,
  ) => Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user?: string | undefined;
        presetId?: string | undefined;
        order?: number | undefined;
        defaultPreset?: boolean | undefined;
        tools?:
          | (
              | string
              | {
                  pluginKey?: string | undefined;
                }
            )[]
          | undefined;
        updatedAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })
    | {
        message: string;
      }
    | null
  >;
  getPresets: (
    user: string,
    filter?: Record<string, unknown>,
  ) => Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user?: string | undefined;
        presetId?: string | undefined;
        order?: number | undefined;
        defaultPreset?: boolean | undefined;
        tools?:
          | (
              | string
              | {
                  pluginKey?: string | undefined;
                }
            )[]
          | undefined;
        updatedAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })[]
    | {
        message: string;
      }
  >;
  savePreset: (
    user: string,
    {
      presetId,
      newPresetId,
      defaultPreset,
      ...preset
    }: {
      presetId?: string;
      newPresetId?: string;
      defaultPreset?: boolean;
      [key: string]: unknown;
    },
  ) => Promise<
    | IPreset
    | {
        message: string;
      }
  >;
  deletePresets: (
    user: string,
    filter?: Record<string, unknown>,
  ) => Promise<import('mongodb').DeleteResult>;
} {
  /**
   * Retrieves a single preset by user and presetId.
   */
  async function getPreset(
    user: string,
    presetId: string,
  ): Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user?: string | undefined;
        presetId?: string | undefined;
        order?: number | undefined;
        defaultPreset?: boolean | undefined;
        tools?:
          | (
              | string
              | {
                  pluginKey?: string | undefined;
                }
            )[]
          | undefined;
        updatedAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })
    | {
        message: string;
      }
    | null
  > {
    try {
      const Preset = mongoose.models.Preset as Model<IPreset>;
      return await Preset.findOne({ user, presetId }).lean();
    } catch (error) {
      logger.error('[getPreset] Error getting single preset', error);
      return { message: 'Error getting single preset' };
    }
  }

  /**
   * Retrieves all presets for a user, sorted by order then updatedAt.
   */
  async function getPresets(
    user: string,
    filter: Record<string, unknown> = {},
  ): Promise<
    | (import('mongoose').FlattenMaps<{
        [x: string]: unknown;
        user?: string | undefined;
        presetId?: string | undefined;
        order?: number | undefined;
        defaultPreset?: boolean | undefined;
        tools?:
          | (
              | string
              | {
                  pluginKey?: string | undefined;
                }
            )[]
          | undefined;
        updatedAt?: Date | undefined;
      }> & {
        _id: import('mongoose').Types.ObjectId;
      } & {
        __v: number;
      })[]
    | {
        message: string;
      }
  > {
    try {
      const Preset = mongoose.models.Preset as Model<IPreset>;
      const presets = await Preset.find({ ...filter, user }).lean();
      const defaultValue = 10000;

      presets.sort((a, b) => {
        const orderA = a.order !== undefined ? a.order : defaultValue;
        const orderB = b.order !== undefined ? b.order : defaultValue;

        if (orderA !== orderB) {
          return orderA - orderB;
        }

        return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
      });

      return presets;
    } catch (error) {
      logger.error('[getPresets] Error getting presets', error);
      return { message: 'Error retrieving presets' };
    }
  }

  /**
   * Saves a preset. Handles default preset logic and tool normalization.
   */
  async function savePreset(
    user: string,
    {
      presetId,
      newPresetId,
      defaultPreset,
      ...preset
    }: {
      presetId?: string;
      newPresetId?: string;
      defaultPreset?: boolean;
      [key: string]: unknown;
    },
  ): Promise<
    | IPreset
    | {
        message: string;
      }
  > {
    try {
      const Preset = mongoose.models.Preset as Model<IPreset>;
      const setter: Record<string, unknown> = { $set: {} };
      const { user: _unusedUser, ...cleanPreset } = preset;
      const update: Record<string, unknown> = { presetId, ...cleanPreset };
      if (preset.tools && Array.isArray(preset.tools)) {
        update.tools =
          (preset.tools as Array<string | { pluginKey?: string }>)
            .map((tool) => (typeof tool === 'object' && tool?.pluginKey ? tool.pluginKey : tool))
            .filter((toolName) => typeof toolName === 'string') ?? [];
      }
      if (newPresetId) {
        update.presetId = newPresetId;
      }

      if (defaultPreset) {
        update.defaultPreset = defaultPreset;
        update.order = 0;

        const currentDefault = await Preset.findOne({ defaultPreset: true, user });

        if (currentDefault && currentDefault.presetId !== presetId) {
          await Preset.findByIdAndUpdate(currentDefault._id, {
            $unset: { defaultPreset: '', order: '' },
          });
        }
      } else if (defaultPreset === false) {
        update.defaultPreset = undefined;
        update.order = undefined;
        setter['$unset'] = { defaultPreset: '', order: '' };
      }

      setter.$set = update;
      return await Preset.findOneAndUpdate({ presetId, user }, setter, {
        new: true,
        upsert: true,
      });
    } catch (error) {
      logger.error('[savePreset] Error saving preset', error);
      return { message: 'Error saving preset' };
    }
  }

  /**
   * Deletes presets matching the given filter for a user.
   */
  async function deletePresets(
    user: string,
    filter: Record<string, unknown> = {},
  ): Promise<import('mongodb').DeleteResult> {
    const Preset = mongoose.models.Preset as Model<IPreset>;
    const deleteCount = await Preset.deleteMany({ ...filter, user });
    return deleteCount;
  }

  return {
    getPreset,
    getPresets,
    savePreset,
    deletePresets,
  };
}

export type PresetMethods = ReturnType<typeof createPresetMethods>;
