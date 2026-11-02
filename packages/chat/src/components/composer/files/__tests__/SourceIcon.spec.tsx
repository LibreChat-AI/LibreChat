/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { EModelEndpoint, FileSources } from 'librechat-data-provider';
import type { FilesHost } from '../../../../react/files';
import { FilesHostProvider } from '../../../../react/files';
import SourceIcon from '../SourceIcon';

const host: FilesHost = {
  renderEndpointIcon: (endpoint) => <span data-testid="endpoint-icon">{endpoint}</span>,
};

describe('SourceIcon', () => {
  it('draws the host mark for a provider-stored file', () => {
    render(
      <FilesHostProvider host={host}>
        <SourceIcon source={FileSources.azure} />
      </FilesHostProvider>,
    );
    expect(screen.getByTestId('endpoint-icon')).toHaveTextContent(EModelEndpoint.azureOpenAI);
  });

  it('keeps the badge without a mark when no host is mounted', () => {
    const { container } = render(<SourceIcon source={FileSources.openai} />);
    expect(container.firstElementChild).not.toBeNull();
    expect(screen.queryByTestId('endpoint-icon')).toBeNull();
  });

  it('draws its own glyph for code, text and vector sources and nothing for local files', () => {
    const { container, rerender } = render(<SourceIcon isCodeFile />);
    expect(container.querySelector('svg')).not.toBeNull();

    rerender(<SourceIcon source={FileSources.vectordb} />);
    expect(container.firstElementChild).toHaveClass('bg-series-4');

    rerender(<SourceIcon source={FileSources.local} />);
    expect(container).toBeEmptyDOMElement();
  });
});
