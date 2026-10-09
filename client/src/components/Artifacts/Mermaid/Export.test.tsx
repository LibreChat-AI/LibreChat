import React from 'react';
import { render } from '@testing-library/react';
import type { ProcessedMermaidSvg } from '~/utils/diagram/export';
import type { Artifact } from '~/common';
import { TOOL_ARTIFACT_TYPES } from '~/utils/artifacts';
import MermaidExport from './Export';

interface ExportProps {
  svg?: string | null;
  dimensions?: ProcessedMermaidSvg['dimensions'];
  filename: string;
  buttonClassName?: string;
  onDownloadSource?: (event: React.MouseEvent<HTMLElement>) => void | Promise<void>;
}

const mockExport = jest.fn((_props: ExportProps) => null);

jest.mock('~/components/Messages/Content/Mermaid/Export', () => ({
  __esModule: true,
  default: (props: ExportProps) => mockExport(props),
}));

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

const mockArtifactDownload = jest.fn();

jest.mock('~/hooks/Artifacts/useArtifactDownload', () => ({
  __esModule: true,
  default: () => ({ isDownloaded: false, handleDownload: mockArtifactDownload }),
}));

const artifact: Artifact = {
  id: 'tool-artifact-flow chart.mmd',
  type: TOOL_ARTIFACT_TYPES.MERMAID,
  title: 'flow.mmd',
  content: 'graph TD\nA-->B',
  lastUpdateTime: 1,
};

describe('Artifact Mermaid export', () => {
  beforeEach(() => {
    mockExport.mockClear();
  });

  it('reuses the SVG and dimensions already rendered by the Artifact preview', () => {
    const exportData: ProcessedMermaidSvg = {
      svg: '<svg viewBox="0 0 400 200" />',
      dimensions: { width: 400, height: 200 },
    };

    render(<MermaidExport artifact={artifact} exportData={exportData} />);

    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({
        svg: exportData.svg,
        dimensions: exportData.dimensions,
        filename: 'flow.mmd',
      }),
    );
  });

  /* The panel renders no separate download button for mermaid, so this menu
   * has to carry the source download — including before any preview has
   * rendered, when SVG and PNG have nothing to work from. */
  it('offers the source download even before the preview SVG is ready', () => {
    render(<MermaidExport artifact={artifact} />);

    expect(mockExport).toHaveBeenCalledTimes(1);
    const props = mockExport.mock.calls[0][0];
    expect(props.svg).toBeUndefined();
    expect(props.onDownloadSource).toBe(mockArtifactDownload);
  });
});
