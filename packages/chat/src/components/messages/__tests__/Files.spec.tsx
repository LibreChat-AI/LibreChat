/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { TFile, TMessage } from 'librechat-data-provider';
import type { MessagePartsImageProps, MessagePartsFilePreviewProps } from '../../../react/host';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../../react/host';
import { initEnglish } from '../../../__fixtures__/i18n';
import MessageFiles from '../Files';

beforeAll(initEnglish);

const image: TFile = {
  user: 'owner',
  bytes: 1024,
  embedded: false,
  object: 'file',
  usage: 0,
  file_id: 'image',
  filename: 'screenshot.png',
  type: 'image/png',
  filepath: '/images/screenshot.png',
  preview: '/images/preview.png',
  width: 1024,
  height: 768,
};

function renderFiles(files?: TMessage['files'], fileMap?: Record<string, TFile>, shareId?: string) {
  const renderImage = jest.fn(({ altText }: MessagePartsImageProps) => <img alt={altText} />);
  const renderFilePreview = jest.fn(
    ({ open, onOpenChange, fileName, deliveryPath }: MessagePartsFilePreviewProps) =>
      open ? (
        <button onClick={() => onOpenChange(false)} data-delivery-path={deliveryPath}>
          {fileName} preview
        </button>
      ) : null,
  );
  const host = createMessagePartsHost({
    useFileMap: () => fileMap,
    useShare: () => ({ shareId }),
    renderImage,
    renderFilePreview,
  });
  const result = render(
    <MessagePartsHostProvider host={host}>
      <MessageFiles files={files} />
    </MessagePartsHostProvider>,
  );
  return { ...result, renderImage, renderFilePreview };
}

describe('MessageFiles', () => {
  it('reuses normal chat image presentation and preview metadata', () => {
    const { renderImage } = renderFiles([image]);
    expect(renderImage).toHaveBeenCalledWith({
      alignRight: true,
      className: 'border-surface-user-message mt-0 shadow-none',
      imagePath: image.preview,
      width: image.width,
      height: image.height,
      altText: image.filename,
    });
  });

  it('opens and closes extracted-image previews hydrated from the owner cache', () => {
    const { renderImage } = renderFiles([image], {
      image: { ...image, llmDeliveryPath: 'text' },
    });
    expect(renderImage).not.toHaveBeenCalled();
    const file = screen.getByRole('button', { name: image.filename });
    expect(file).toHaveClass('border-surface-user-message', 'max-w-full', 'bg-transparent');
    fireEvent.click(file);
    const preview = screen.getByRole('button', { name: `${image.filename} preview` });
    expect(preview).toHaveAttribute('data-delivery-path', 'text');
    fireEvent.click(preview);
    expect(preview).not.toBeInTheDocument();
  });

  it('does not hydrate shared attachments from the signed-in viewer cache', () => {
    renderFiles([image], { image: { ...image, llmDeliveryPath: 'text' } }, 'share-1');
    expect(screen.getByRole('img', { name: image.filename })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps persisted extracted-image metadata on reload and share', () => {
    renderFiles([{ ...image, llmDeliveryPath: 'text' }], undefined, 'share-1');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: image.filename }));
    expect(screen.getByRole('button', { name: `${image.filename} preview` })).toHaveAttribute(
      'data-delivery-path',
      'text',
    );
  });

  it.each([undefined, []])('renders nothing when files are %s', (files) => {
    const { container, renderImage, renderFilePreview } = renderFiles(files);
    expect(container).toBeEmptyDOMElement();
    expect(renderImage).not.toHaveBeenCalled();
    expect(renderFilePreview).not.toHaveBeenCalled();
  });
});
