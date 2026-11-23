import { useMemo } from 'react';
import { ComposerPalette } from '@librechat/chat/components';
import { ComposerHostProvider, useComposerHost } from '@librechat/chat/react';
import type { ComposerPaletteProps } from '@librechat/chat/components';
import { usePaletteSources } from './Composer/sources';
import PaletteList from './PaletteList';

/**
 * Binds the app's palette data to the package list. The package reads favorites, uploads and
 * dialogs from the composer host; this installs that host for a composer rendered outside the
 * root provider, and keeps a parent host's other capabilities.
 */
export default function Palette(props: ComposerPaletteProps) {
  const parent = useComposerHost();
  const host = useMemo(
    () => ({
      ...parent,
      usePaletteSources,
      renderPaletteList:
        parent.renderPaletteList ?? ((listProps) => <PaletteList {...listProps} />),
    }),
    [parent],
  );

  return (
    <ComposerHostProvider host={host}>
      <ComposerPalette {...props} />
    </ComposerHostProvider>
  );
}
