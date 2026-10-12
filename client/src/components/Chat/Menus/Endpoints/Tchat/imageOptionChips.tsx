import { Maximize2, Proportions, Scaling } from 'lucide-react';
import type { TImageChoice, TImageSpec } from 'librechat-data-provider';
import type { PaletteEntry } from '~/hooks/Input/usePaletteEntries';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { sizeLabel } from './imageOptions';

interface Group {
  field: keyof TImageChoice;
  values: string[] | undefined;
  labelKey: TranslationKeys;
  icon: React.ReactNode;
  format: (value: string) => string;
}

const identity = (value: string) => value;

/**
 * One bar chip per parameter the active image model honours, placed after the
 * Image Gen chip: its label names the parameter, its menu holds Auto plus the
 * model's values, and its ✕ (shown only while a value is pinned) goes back to
 * Auto, which leaves the choice to the chat model. Bar-only: they never appear
 * as palette rows, so they cannot be pinned or favourited on their own.
 */
export function imageOptionChips({
  spec,
  choice,
  pick,
  localize,
}: {
  spec: TImageSpec;
  choice: TImageChoice | undefined;
  pick: (field: keyof TImageChoice, value: string | undefined) => void;
  localize: (key: TranslationKeys) => string;
}): PaletteEntry[] {
  const options = spec.options ?? {};
  const groups: Group[] = [
    {
      field: 'aspectRatio',
      values: options.aspectRatios,
      labelKey: 'com_ui_aspect_ratio',
      icon: <Proportions className="icon-md" aria-hidden="true" />,
      format: identity,
    },
    {
      field: 'imageSize',
      values: options.imageSizes,
      labelKey: 'com_ui_resolution',
      icon: <Maximize2 className="icon-md" aria-hidden="true" />,
      format: identity,
    },
    {
      field: 'size',
      values: options.sizes,
      labelKey: 'com_ui_image_size',
      icon: <Scaling className="icon-md" aria-hidden="true" />,
      format: sizeLabel,
    },
  ];

  return groups
    .filter((group) => (group.values?.length ?? 0) > 0)
    .map(({ field, values = [], labelKey, icon, format }) => {
      const pinned = choice?.[field];
      const current = pinned != null && values.includes(pinned) ? pinned : undefined;
      return {
        key: `image_option:${field}`,
        itemType: 'builtin',
        itemId: `image_option_${field}`,
        label: localize(labelKey),
        icon,
        section: 'tool',
        active: true,
        pinned: false,
        favoritable: false,
        onSelect: () => pick(field, undefined),
        chipRemovable: current != null,
        chipModes: [
          {
            id: 'auto',
            label: localize('com_ui_auto'),
            active: current == null,
            onSelect: () => pick(field, undefined),
          },
          ...values.map((value) => ({
            id: value,
            label: format(value),
            active: current === value,
            onSelect: () => pick(field, value),
          })),
        ],
      };
    });
}
