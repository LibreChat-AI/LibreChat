import React from 'react';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { downloadMermaidPng, downloadMermaidSvg } from '~/utils/diagram/export';
import MermaidExport from './Export';

const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

jest.mock('~/utils/diagram/export', () => ({
  downloadMermaidPng: jest.fn(),
  downloadMermaidSvg: jest.fn(),
}));

const mockDownloadMermaidPng = jest.mocked(downloadMermaidPng);
const mockDownloadMermaidSvg = jest.mocked(downloadMermaidSvg);

describe('MermaidExport', () => {
  beforeEach(() => {
    document.documentElement.style.setProperty('--surface-primary-alt', '23 23 23');
    mockShowToast.mockReset();
    mockDownloadMermaidPng.mockResolvedValue();
    mockDownloadMermaidSvg.mockReset();
  });

  it('renders the menu inside the fullscreen element when one is given', async () => {
    const user = userEvent.setup();
    const fullscreenHost = document.createElement('div');
    document.body.appendChild(fullscreenHost);

    render(
      <MermaidExport
        svg={'<svg viewBox="0 0 400 200" />'}
        dimensions={{ width: 400, height: 200 }}
        filename="flow.mmd"
        portalElement={fullscreenHost}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'com_ui_export_mermaid' }));

    const menu = await screen.findByRole('menu');
    expect(fullscreenHost.contains(menu)).toBe(true);

    fullscreenHost.remove();
  });

  it('exports an already-rendered inline diagram as SVG and PNG', async () => {
    const user = userEvent.setup();
    render(
      <MermaidExport
        svg={'<svg viewBox="0 0 400 200" />'}
        dimensions={{ width: 400, height: 200 }}
        filename="flow.mmd"
      />,
    );

    const trigger = screen.getByRole('button', { name: 'com_ui_export_mermaid' });
    await user.click(trigger);
    expect(await screen.findByRole('menu')).toHaveClass('popover-ui');
    await user.click(await screen.findByRole('menuitem', { name: 'com_ui_export_svg' }));
    await waitFor(() =>
      expect(mockDownloadMermaidSvg).toHaveBeenCalledWith(
        '<svg viewBox="0 0 400 200" />',
        'flow.mmd',
        'rgb(23 23 23)',
      ),
    );
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'com_ui_export_png' }));
    await waitFor(() =>
      expect(mockDownloadMermaidPng).toHaveBeenCalledWith(
        '<svg viewBox="0 0 400 200" />',
        'flow.mmd',
        { width: 400, height: 200 },
        'rgb(23 23 23)',
      ),
    );
  });

  it('keeps both formats disabled until an existing preview SVG is ready', async () => {
    const user = userEvent.setup();
    render(<MermaidExport filename="flow chart.mmd" />);

    await user.click(screen.getByRole('button', { name: 'com_ui_export_mermaid' }));

    expect(screen.getByRole('menuitem', { name: 'com_ui_export_svg' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'com_ui_export_png' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(mockDownloadMermaidSvg).not.toHaveBeenCalled();
    expect(mockDownloadMermaidPng).not.toHaveBeenCalled();
  });

  it('supports keyboard export and restores focus to its trigger', async () => {
    const user = userEvent.setup();
    render(<MermaidExport svg={'<svg viewBox="0 0 400 200" />'} filename="flow.mmd" />);

    await user.tab();
    const trigger = screen.getByRole('button', { name: 'com_ui_export_mermaid' });
    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
    const svgItem = await screen.findByRole('menuitem', { name: 'com_ui_export_svg' });
    /* `Home` rather than `ArrowDown`: opening from the keyboard sometimes
     * lands on the first item already (CI observed it active), and one
     * ArrowDown from there walks past SVG onto PNG. `Home` is the first
     * item from either starting point, which is what a keyboard user gets. */
    await user.keyboard('{Home}');
    await waitFor(() => expect(svgItem).toHaveFocus());
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(mockDownloadMermaidSvg).toHaveBeenCalledWith(
        '<svg viewBox="0 0 400 200" />',
        'flow.mmd',
        'rgb(23 23 23)',
      ),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('turns the pressed format into its own loading row and blocks the other', async () => {
    const user = userEvent.setup();
    let finishExport: (() => void) | undefined;
    mockDownloadMermaidPng.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishExport = resolve;
        }),
    );
    render(<MermaidExport svg={'<svg viewBox="0 0 400 200" />'} filename="flow.mmd" />);

    const trigger = screen.getByRole('button', { name: 'com_ui_export_mermaid' });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'com_ui_export_png' }));

    expect(trigger).toHaveAttribute('aria-busy', 'true');
    expect(trigger.querySelector('.lucide-loader-circle')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_mermaid_exporting_png');
    await waitFor(() => expect(mockDownloadMermaidPng).toHaveBeenCalled());

    await user.click(trigger);
    const menu = within(screen.getByRole('menu'));
    /* The menu keeps exactly its two format rows: the pressed one becomes the
     * loading row in place, rather than a third status row appearing beside
     * two options that still look idle. */
    expect(menu.getAllByRole('menuitem')).toHaveLength(2);
    const running = menu.getByRole('menuitem', { name: 'com_ui_mermaid_exporting_png' });
    expect(running).toHaveTextContent('com_ui_loading');
    expect(running.querySelector('.lucide-loader-circle')).not.toBeNull();
    expect(running).toHaveAttribute('aria-disabled', 'true');
    expect(menu.queryByText('com_ui_export_png')).not.toBeInTheDocument();
    /* The other format cannot be started on top of the running one. */
    expect(menu.getByRole('menuitem', { name: 'com_ui_export_svg' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await act(async () => finishExport?.());
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_mermaid_export_complete');
    /* The menu is still open from the click above — the rows recover in place. */
    expect(menu.getByRole('menuitem', { name: 'com_ui_export_png' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('waits for a paint, not just a later task, before a synchronous export', async () => {
    /* `downloadMermaidSvg` blocks the frame it runs in, so it must not start
     * until the browser has had a rendering opportunity to show the loading
     * row: a bare `setTimeout` can fire before that paint. `fireEvent` is
     * synchronous, so nothing has flushed the deferral yet. */
    const user = userEvent.setup();
    const frames: Array<FrameRequestCallback> = [];
    const rafSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
    try {
      render(<MermaidExport svg={'<svg viewBox="0 0 400 200" />'} filename="flow.mmd" />);

      const trigger = screen.getByRole('button', { name: 'com_ui_export_mermaid' });
      await user.click(trigger);
      fireEvent.click(await screen.findByRole('menuitem', { name: 'com_ui_export_svg' }));

      expect(mockDownloadMermaidSvg).not.toHaveBeenCalled();
      expect(trigger).toHaveAttribute('aria-busy', 'true');
      /* Still nothing on timers alone: the export is behind a frame. */
      await act(async () => {
        jest.advanceTimersByTime?.(0);
      });
      expect(mockDownloadMermaidSvg).not.toHaveBeenCalled();

      await act(async () => {
        frames.splice(0).forEach((frame) => frame(0));
      });
      await waitFor(() => expect(mockDownloadMermaidSvg).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(trigger).not.toHaveAttribute('aria-busy'));
    } finally {
      rafSpy.mockRestore();
    }
  });

  it('saves the diagram source from the menu before any preview SVG exists', async () => {
    /* The source is the artifact's own content, so it is the one item that
     * never waits on a render — and the only enabled item on the code tab. */
    const user = userEvent.setup();
    const onDownloadSource = jest.fn().mockResolvedValue(true);
    render(<MermaidExport filename="flow.mmd" onDownloadSource={onDownloadSource} />);

    await user.click(screen.getByRole('button', { name: 'com_ui_export_mermaid' }));
    const sourceItem = await screen.findByRole('menuitem', {
      name: 'com_ui_export_mermaid_source',
    });
    expect(sourceItem).not.toHaveAttribute('aria-disabled', 'true');

    await user.click(sourceItem);
    await waitFor(() => expect(onDownloadSource).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('com_ui_mermaid_export_complete'),
    );
  });

  it('announces a failed source download without a second toast', async () => {
    /* The stored file can be gone (expired code-output URL, deleted file):
     * the download helper reports that as `false` after raising its own
     * "Error downloading file" toast, so the menu only updates its live
     * region — announcing "export complete" would be a lie and a second
     * toast would be noise. */
    const user = userEvent.setup();
    const onDownloadSource = jest.fn().mockResolvedValue(false);
    render(<MermaidExport filename="flow.mmd" onDownloadSource={onDownloadSource} />);

    await user.click(screen.getByRole('button', { name: 'com_ui_export_mermaid' }));
    await user.click(await screen.findByRole('menuitem', { name: 'com_ui_export_mermaid_source' }));

    await waitFor(() => expect(onDownloadSource).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('com_ui_mermaid_export_failed'),
    );
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('raises its own toast when an export throws', async () => {
    /* A thrown task told nobody, so this menu is the only layer that can
     * report it. */
    const user = userEvent.setup();
    const onDownloadSource = jest.fn().mockRejectedValue(new Error('boom'));
    render(<MermaidExport filename="flow.mmd" onDownloadSource={onDownloadSource} />);

    await user.click(screen.getByRole('button', { name: 'com_ui_export_mermaid' }));
    await user.click(await screen.findByRole('menuitem', { name: 'com_ui_export_mermaid_source' }));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        status: 'error',
        message: 'com_ui_mermaid_export_failed',
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_mermaid_export_failed');
  });
});
