import { useState } from 'react';
import '@testing-library/jest-dom';
import * as Primitive from '@radix-ui/react-dialog';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { OverlayRegistration, RegisterOverlay } from '../../Providers/Overlay';
import { OverlayBackProvider } from '../../Providers/Overlay';
import { AlertDialog } from '../AlertDialog';
import { OGDialog } from '../OriginalDialog';
import { Dialog } from '../Dialog';

describe.each([
  ['OGDialog', OGDialog],
  ['Dialog', Dialog],
] as const)('%s mobile back registration', (_name, Root) => {
  let layers: Map<string, OverlayRegistration>;
  let register: RegisterOverlay;
  beforeEach(() => {
    layers = new Map();
    register = (layer) => {
      layers.set(layer.id, layer);
      return () => {
        layers.delete(layer.id);
      };
    };
  });

  it('dismisses a trigger-owned dialog through its normal open-change callback', () => {
    const onOpenChange = jest.fn();
    render(
      <OverlayBackProvider value={register}>
        <Root onOpenChange={onOpenChange}>
          <Primitive.Trigger>Open</Primitive.Trigger>
          <Primitive.Content aria-describedby={undefined}>
            <Primitive.Title>Editor</Primitive.Title>
          </Primitive.Content>
        </Root>
      </OverlayBackProvider>,
    );
    expect(layers.size).toBe(0);
    fireEvent.click(screen.getByText('Open'));
    expect(layers.size).toBe(1);
    act(() => {
      [...layers.values()][0].onClose();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(layers.size).toBe(0);
  });

  it('keeps controlled visibility authoritative when dismissal is refused', () => {
    const onOpenChange = jest.fn();
    const view = render(
      <OverlayBackProvider value={register}>
        <Root open onOpenChange={onOpenChange} />
      </OverlayBackProvider>,
    );
    act(() => {
      [...layers.values()][0].onClose();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(layers.size).toBe(1);
    view.unmount();
    expect(layers.size).toBe(0);
  });

  it('supports default-open roots and does not register non-modal dialogs', () => {
    render(
      <OverlayBackProvider value={register}>
        <Root defaultOpen />
        <Root defaultOpen modal={false} />
      </OverlayBackProvider>,
    );
    expect(layers.size).toBe(1);
  });

  it('keeps nested depth and uses the latest close callback without re-registering', () => {
    const callbacks = [jest.fn(), jest.fn()];
    function Nested() {
      const [version, setVersion] = useState(0);
      return (
        <Root open onOpenChange={callbacks[version]}>
          <button onClick={() => setVersion(1)}>Update callback</button>
          <Root defaultOpen />
        </Root>
      );
    }
    render(
      <OverlayBackProvider value={register}>
        <Nested />
      </OverlayBackProvider>,
    );
    const outer = [...layers.values()].find((layer) => layer.depth === 1);
    expect([...layers.values()].map((layer) => layer.depth).sort()).toEqual([1, 2]);
    fireEvent.click(screen.getByText('Update callback'));
    expect([...layers.values()].find((layer) => layer.depth === 1)).toBe(outer);
    act(() => {
      outer?.onClose();
    });
    expect(callbacks[0]).not.toHaveBeenCalled();
    expect(callbacks[1]).toHaveBeenCalledWith(false);
  });
});

it('registers an alert dialog as cancellation, never confirmation', () => {
  let layer: OverlayRegistration | undefined;
  const onOpenChange = jest.fn();
  render(
    <OverlayBackProvider
      value={(value) => {
        layer = value;
        return () => {
          layer = undefined;
        };
      }}
    >
      <AlertDialog defaultOpen onOpenChange={onOpenChange} />
    </OverlayBackProvider>,
  );
  expect(layer).toBeDefined();
  act(() => {
    layer?.onClose();
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(layer).toBeUndefined();
});
