import { useState } from 'react';
import { RecoilRoot } from 'recoil';
import * as Popover from '@radix-ui/react-popover';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import type { TPreset } from 'librechat-data-provider';
import PresetItems from '../PresetItems';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({
    data: {
      Branded: {
        type: 'custom',
        iconURL: 'https://cdn.example.com/x.png',
        order: 0,
      },
    },
  }),
}));

const preset = {
  presetId: 'preset-1',
  title: 'A preset',
  endpoint: 'openAI',
} as TPreset;

/**
 * The real clear is an optimistic query update, so React commits the emptied
 * list and the dialog close together: the item that opened the dialog is
 * already gone when focus is handed back.
 */
function Harness({ onClear }: { onClear: () => void }) {
  const [presets, setPresets] = useState<TPreset[]>([preset]);
  return (
    <RecoilRoot>
      {/* Each row wraps itself in a popover `Close`, which needs the context. */}
      <Popover.Root open={true}>
        <PresetItems
          presets={presets}
          onSetDefaultPreset={jest.fn()}
          onSelectPreset={jest.fn()}
          onChangePreset={jest.fn()}
          onDeletePreset={jest.fn()}
          clearAllPresets={() => {
            setPresets([]);
            onClear();
          }}
          onFileSelected={jest.fn()}
        />
      </Popover.Root>
    </RecoilRoot>
  );
}

function setup() {
  const onClear = jest.fn();
  render(<Harness onClear={onClear} />);
  return { onClear };
}

describe('PresetItems clear-all dialog', () => {
  /**
   * The dialog is controlled and has no trigger, and the menu item that opens
   * it sets `hideOnClick: false` so the menu stays open behind it. Focus has to
   * come back to that item, or a keyboard user is left on the document.
   */
  it('returns focus to the invoking menu item when the dialog is dismissed', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: 'com_ui_more_options' }));
    const clearItem = await screen.findByRole('menuitem', { name: 'com_ui_clear_all' });
    await user.click(clearItem);

    const cancel = await screen.findByRole('button', { name: 'com_ui_cancel' });
    await user.click(cancel);

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(clearItem);
    });
  });

  it('clears the presets when the dialog is confirmed', async () => {
    const user = userEvent.setup();
    const { onClear } = setup();

    await user.click(screen.getByRole('button', { name: 'com_ui_more_options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'com_ui_clear_all' }));
    await user.click(await screen.findByRole('button', { name: 'com_ui_clear' }));

    expect(onClear).toHaveBeenCalled();
  });

  /**
   * Confirming empties the list optimistically, and the item only shows while
   * presets exist, so the element that opened the dialog is gone by the time
   * focus is handed back.
   */
  it('falls back to the options trigger when confirming removed the item', async () => {
    const user = userEvent.setup();
    setup();

    const trigger = screen.getByRole('button', { name: 'com_ui_more_options' });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'com_ui_clear_all' }));
    await user.click(await screen.findByRole('button', { name: 'com_ui_clear' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});

describe('PresetItems icons', () => {
  it('renders a configured endpoint image instead of the generic mark', () => {
    render(
      <RecoilRoot>
        <Popover.Root open={true}>
          <PresetItems
            presets={[{ presetId: 'branded', title: 'Branded', endpoint: 'Branded' } as TPreset]}
            onSetDefaultPreset={jest.fn()}
            onSelectPreset={jest.fn()}
            onChangePreset={jest.fn()}
            onDeletePreset={jest.fn()}
            clearAllPresets={jest.fn()}
            onFileSelected={jest.fn()}
          />
        </Popover.Root>
      </RecoilRoot>,
    );

    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://cdn.example.com/x.png');
  });
});
