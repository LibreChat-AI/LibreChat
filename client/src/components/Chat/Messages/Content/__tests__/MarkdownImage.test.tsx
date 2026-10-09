import React from 'react';
import { render } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import { img as MarkdownImage } from '../MarkdownComponents';
import { MediaContext } from '~/Providers/MediaContext';
import { buildAttachmentsByName } from '~/utils/media';

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  apiBaseUrl: () => 'https://chat.example.com',
}));

const chart: TAttachment = {
  filename: '5_dti.png',
  filepath: '/api/files/code/download/sess/abc/5_dti.png',
  conversationId: 'c1',
} as unknown as TAttachment;

const renderImage = (src: string, attachments?: TAttachment[]) => {
  const { container } = render(
    <MediaContext.Provider value={{ attachmentsByName: buildAttachmentsByName(attachments) }}>
      <MarkdownImage src={src} alt="DTI" />
    </MediaContext.Provider>,
  );
  return container.querySelector('img');
};

describe('markdown img', () => {
  const served = `https://chat.example.com${chart.filepath}`;

  it('resolves a filename the run produced to the real file', () => {
    expect(renderImage('5_dti.png', [chart])).toHaveAttribute('src', served);
  });

  it('resolves the bare sandbox path the model tends to write', () => {
    expect(renderImage('/mnt/data/5_dti.png', [chart])).toHaveAttribute('src', served);
  });

  it('leaves a sandbox: scheme unresolved', () => {
    // react-markdown's default urlTransform allows only http/https/irc/mailto/
    // xmpp, so this source is blanked before `img` is called at all. Resolving
    // it here would only be reachable from a test that skips the pipeline.
    expect(renderImage('sandbox:/mnt/data/5_dti.png', [chart])).toHaveAttribute(
      'src',
      'sandbox:/mnt/data/5_dti.png',
    );
  });

  it('keeps an explicitly addressed server path over a same-named attachment', () => {
    // The author addressed one file. Resolving by basename would display the
    // unrelated attachment instead.
    const other = { ...chart, filepath: '/api/files/other/5_dti.png' } as TAttachment;
    expect(renderImage('/api/files/explicit/5_dti.png', [other])).toHaveAttribute(
      'src',
      'https://chat.example.com/api/files/explicit/5_dti.png',
    );
  });

  it('leaves an unmatched reference exactly as it was', () => {
    expect(renderImage('missing.png', [chart])).toHaveAttribute('src', 'missing.png');
  });

  it('leaves an absolute URL alone', () => {
    const src = 'https://example.com/5_dti.png';
    expect(renderImage(src, [chart])).toHaveAttribute('src', src);
  });

  it('still prefixes the API base onto a bare /images/ path', () => {
    expect(renderImage('/images/user/pic.png')).toHaveAttribute(
      'src',
      'https://chat.example.com/images/user/pic.png',
    );
  });

  it('prefixes the API base onto a resolved /api/ attachment', () => {
    // The default filepath shape for code-execution artifacts. Without the
    // prefix this 404s on any subpath deployment.
    expect(renderImage('5_dti.png', [chart])).toHaveAttribute(
      'src',
      `https://chat.example.com${chart.filepath}`,
    );
  });

  it('prefixes the API base onto a resolved /images/ attachment', () => {
    const upload = { ...chart, filepath: '/images/user/5_dti.png' } as TAttachment;
    expect(renderImage('5_dti.png', [upload])).toHaveAttribute(
      'src',
      'https://chat.example.com/images/user/5_dti.png',
    );
  });

  it('renders unchanged with no media context at all', () => {
    const { container } = render(<MarkdownImage src="5_dti.png" alt="DTI" />);
    expect(container.querySelector('img')).toHaveAttribute('src', '5_dti.png');
  });
});
