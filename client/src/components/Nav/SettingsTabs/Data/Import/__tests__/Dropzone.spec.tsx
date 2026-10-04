import { render, screen, fireEvent } from 'test/layout-test-utils';
import Dropzone from '../Dropzone';

function transfer(files: File[] = [], types: string[] = ['Files']) {
  return { types, files };
}

const zip = () => new File(['zip-bytes'], 'export.zip', { type: 'application/zip' });

/** The tint that appears over the settings row while a file is dragged across
 * it. Selected on `pointer-events-none` rather than `aria-hidden` alone: the
 * button's decorative icon is also aria-hidden, and an SVG's `className` is an
 * `SVGAnimatedString` rather than a string. */
function overlayOf(container: HTMLElement): HTMLElement {
  const overlay = container.querySelector('div[aria-hidden="true"].pointer-events-none');
  if (!overlay) {
    throw new Error('drag overlay not found');
  }
  return overlay as HTMLElement;
}

describe('Dropzone drag and drop', () => {
  it('imports a dropped export', () => {
    const onFile = jest.fn();
    const file = zip();
    const { container } = render(<Dropzone onFile={onFile} isUploading={false} />);
    const zone = container.firstChild as HTMLElement;

    fireEvent.drop(zone, { dataTransfer: transfer([file]) });

    expect(onFile).toHaveBeenCalledWith(file);
  });

  /**
   * The counter is load-bearing: dragenter and dragleave both fire for every
   * child element crossed, so a plain boolean flickers the overlay off as soon
   * as the pointer moves between the label and the button. Replacing the
   * counter with a boolean passes every other test in this file.
   */
  it('keeps the overlay up while the pointer crosses a child element', () => {
    const { container } = render(<Dropzone onFile={jest.fn()} isUploading={false} />);
    const zone = container.firstChild as HTMLElement;
    const child = screen.getByRole('button');
    const overlay = () => overlayOf(container);

    fireEvent.dragEnter(zone, { dataTransfer: transfer() });
    expect(overlay()).toHaveClass('bg-surface-primary/70', 'opacity-100');
    expect(overlay()).not.toHaveClass('bg-surface-overlay/70');

    fireEvent.dragEnter(child, { dataTransfer: transfer() });
    fireEvent.dragLeave(child, { dataTransfer: transfer() });
    expect(overlay().className).toContain('opacity-100');

    fireEvent.dragLeave(zone, { dataTransfer: transfer() });
    expect(overlay().className).toContain('opacity-0');
  });

  it('ignores a drag that carries no files', () => {
    const onFile = jest.fn();
    const { container } = render(<Dropzone onFile={onFile} isUploading={false} />);
    const zone = container.firstChild as HTMLElement;
    const overlay = () => overlayOf(container);

    fireEvent.dragEnter(zone, { dataTransfer: transfer([], ['text/plain']) });
    expect(overlay().className).toContain('opacity-0');

    fireEvent.drop(zone, { dataTransfer: transfer([], ['text/plain']) });
    expect(onFile).not.toHaveBeenCalled();
  });

  /** A drop accepted mid-upload would start a second, concurrent import of a
   * different archive over the top of the first. */
  it('accepts no drop while an upload is already in flight', () => {
    const onFile = jest.fn();
    const { container } = render(<Dropzone onFile={onFile} isUploading />);
    const zone = container.firstChild as HTMLElement;

    fireEvent.drop(zone, { dataTransfer: transfer([zip()]) });

    expect(onFile).not.toHaveBeenCalled();
  });

  it('imports a file chosen through the button', () => {
    const onFile = jest.fn();
    const file = zip();
    const { container } = render(<Dropzone onFile={onFile} isUploading={false} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    expect(onFile).toHaveBeenCalledWith(file);
    expect(input.value).toBe('');
  });

  it('recovers after a drag that ends outside the row', () => {
    const onFile = jest.fn();
    const { container } = render(<Dropzone onFile={onFile} isUploading={false} />);
    const zone = container.firstChild as HTMLElement;
    const overlay = () => overlayOf(container);

    fireEvent.dragEnter(zone, { dataTransfer: transfer() });
    fireEvent.dragLeave(zone, { dataTransfer: transfer() });
    expect(overlay().className).toContain('opacity-0');

    fireEvent.dragEnter(zone, { dataTransfer: transfer() });
    expect(overlay().className).toContain('opacity-100');
  });
});
