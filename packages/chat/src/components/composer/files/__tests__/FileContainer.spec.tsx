/**
 * @jest-environment jsdom
 */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TFile } from 'librechat-data-provider';
import FileContainer from '../FileContainer';

jest.mock('../kinds', () => ({
  getFileType: () => ({ paths: () => null, fillClassName: '', title: 'Plain' }),
}));

jest.mock('../FilePreview', () => ({
  __esModule: true,
  default: () => <div data-testid="file-preview" />,
}));

jest.mock('../RemoveFile', () => ({
  __esModule: true,
  default: () => <button data-testid="remove-file" />,
}));

const baseFile = (overrides: Partial<TFile> = {}): Partial<TFile> => ({
  file_id: 'f1',
  filename: 'report.pdf',
  type: 'application/pdf',
  ...overrides,
});

describe('FileContainer chip label', () => {
  it('shows the raw filename when no `displayName` is supplied (upload context)', () => {
    /** A user-uploaded file whose name happens to look like the
     * code-execution collision suffix (`-<6 hex>` before extension) must
     * not have its name silently rewritten — historically a global
     * `displayFilename(file.filename)` call here would strip the suffix
     * and turn `report-abc123.pdf` into `report.pdf`. Stripping is now
     * opt-in via `displayName`, so upload chips show the raw name. */
    render(<FileContainer file={baseFile({ filename: 'report-abc123.pdf' })} />);
    expect(screen.getByText('report-abc123.pdf')).toBeInTheDocument();
  });

  it('uses `displayName` when supplied (artifact context opts in)', () => {
    render(
      <FileContainer
        file={baseFile({ filename: 'archive-deadbe.zip', type: 'application/zip' })}
        displayName="archive.zip"
      />,
    );
    expect(screen.getByText('archive.zip')).toBeInTheDocument();
    expect(screen.queryByText(/-deadbe/)).not.toBeInTheDocument();
  });

  it('falls back to empty string when neither `displayName` nor `filename` is set', () => {
    const { container } = render(<FileContainer file={{ file_id: 'noname' } as Partial<TFile>} />);
    /** Title element exists but is empty — no crash, no `undefined`. */
    expect(container.querySelector('.font-medium')?.textContent).toBe('');
  });
});

describe('FileContainer subtitle action', () => {
  const subtitleAction = (onClick = jest.fn()) => ({ label: 'Move back into message', onClick });

  it('states the action on the chip instead of the file type', () => {
    render(
      <FileContainer file={baseFile()} onClick={jest.fn()} subtitleAction={subtitleAction()} />,
    );

    /** The action is the subtitle now, not something the file type is swapped out for. */
    expect(screen.getByText('Move back into message')).toBeInTheDocument();
    expect(screen.queryByText('Plain')).not.toBeInTheDocument();
  });

  it('leaves the control holding the label and nothing else', () => {
    render(
      <FileContainer file={baseFile()} onClick={jest.fn()} subtitleAction={subtitleAction()} />,
    );

    /** The swap this replaced kept BOTH labels mounted and hid one in CSS, so the control read
     * "PlainMove back into message". Anchoring the text is what catches that, and anchoring is
     * required: a substring match accepts the gated arrangement.
     *
     * It is also the only half of the invariant jsdom can decide. No stylesheet is loaded, so
     * whether a mounted node is VISUALLY hidden is unobservable here — by `invisible`,
     * `opacity-[0]`, `text-transparent`, `!hidden`, an ancestor's `opacity-0
     * group-hover:opacity-100`, or a spelling nobody has written yet. Three attempts to infer
     * it from class tokens each missed gates and each rejected innocuous styling
     * (`hover:inline-flex` is layout, not concealment). A guard that reads as sound while
     * missing gates is worse than no guard, so the claim is narrowed to what holds. A real
     * visibility assertion needs a browser — `toBeVisible()` under `e2e/`, which has no
     * composer-paste spec to hang it on yet. */
    const control = screen.getByRole('button', { name: 'Move back into message' });
    expect(control).toHaveTextContent(/^Move back into message$/);
  });

  it('names the subtitle control from its own visible label', () => {
    render(
      <FileContainer file={baseFile()} onClick={jest.fn()} subtitleAction={subtitleAction()} />,
    );

    /** Visible text and accessible name are the same string, so voice control can act on what
     * the label says without an `aria-label` shadowing it. */
    const control = screen.getByRole('button', { name: 'Move back into message' });
    expect(control).not.toHaveAttribute('aria-label');
  });

  it('runs the subtitle action without also opening the chip', async () => {
    const onClick = jest.fn();
    const onSubtitleClick = jest.fn();
    render(
      <FileContainer
        file={baseFile()}
        onClick={onClick}
        ariaLabel="Edit pasted text"
        subtitleAction={subtitleAction(onSubtitleClick)}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Move back into message' }));

    expect(onSubtitleClick).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps the chip itself clickable alongside the subtitle control', async () => {
    const onClick = jest.fn();
    render(
      <FileContainer
        file={baseFile()}
        onClick={onClick}
        ariaLabel="Edit pasted text"
        subtitleAction={subtitleAction()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Edit pasted text' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('never nests the subtitle control inside the chip control', () => {
    const { container } = render(
      <FileContainer file={baseFile()} onClick={jest.fn()} subtitleAction={subtitleAction()} />,
    );

    /** A button inside a button is invalid markup and browsers drop the inner one's events. */
    expect(container.querySelector('button button')).toBeNull();
  });

  it('keeps the full-chip focus indicator inside the clipped surface', () => {
    render(
      <FileContainer file={baseFile()} onClick={jest.fn()} subtitleAction={subtitleAction()} />,
    );

    /** The surface applies `overflow-hidden`, so an offset ring on the full-bleed button would
     * be clipped away entirely; the treatment draws inside the target instead. */
    const chipControl = screen.getByRole('button', { name: 'report.pdf' });
    expect(chipControl.className).toContain('focus-visible:ring-inset');
    expect(chipControl.className).not.toContain('ring-offset');
  });

  it('reads as a control rather than as a description', () => {
    render(
      <FileContainer file={baseFile()} onClick={jest.fn()} subtitleAction={subtitleAction()} />,
    );

    /** It keeps the subtitle's weight, but a permanent line of secondary text with no marking
     * would read as a caption; the underline is what says it can be clicked. */
    const control = screen.getByRole('button', { name: 'Move back into message' });
    expect(control.className).toContain('text-text-secondary');
    expect(control.className).toContain('underline');
    expect(control.className).not.toContain('hover:underline');
  });

  it('gives keyboard focus the same feedback the pointer gets', () => {
    render(
      <FileContainer file={baseFile()} onClick={jest.fn()} subtitleAction={subtitleAction()} />,
    );

    /** The focus ring already announces focus, so this is parity rather than a missing
     * indicator: whatever the colour shift signals to a pointer, it signals to a keyboard. */
    const control = screen.getByRole('button', { name: 'Move back into message' });
    expect(control.className).toContain('hover:text-text-primary');
    expect(control.className).toContain('focus-visible:text-text-primary');
  });

  it('leaves the plain subtitle alone when no action is offered', () => {
    render(<FileContainer file={baseFile()} onClick={jest.fn()} />);

    expect(screen.getByText('Plain')).toBeInTheDocument();
    expect(screen.queryByText('Move back into message')).not.toBeInTheDocument();
  });
});

describe('FileContainer text preview', () => {
  const textFile = (overrides: Partial<TFile> = {}) =>
    baseFile({ type: 'text/plain', filename: 'pasted-text.txt', ...overrides });

  it('renders a persisted snippet without full text or the upload cache', () => {
    const preview = 'This text survives a conversation reload.';
    render(<FileContainer file={textFile({ textPreview: preview })} />);
    expect(screen.getByText(preview)).toBeInTheDocument();
    expect(screen.queryByTestId('file-preview')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'pasted-text.txt' })).toHaveAccessibleDescription(
      preview,
    );
  });

  it('shows stored plain text instead of the colored file tile', () => {
    const text = 'The actual clipboard content\nwith a second line';
    render(<FileContainer file={textFile({ text })} />);

    const preview = screen.getByText('The actual clipboard content with a second line');
    expect(preview).toHaveAttribute('title', text);
    expect(preview.textContent).toBe(text);
    expect(screen.getByRole('button', { name: 'pasted-text.txt' })).toHaveAccessibleDescription(
      text,
    );
    expect(screen.getByText('pasted-text.txt')).toBeInTheDocument();
    expect(screen.queryByTestId('file-preview')).not.toBeInTheDocument();
    expect(screen.queryByText('Plain')).not.toBeInTheDocument();
  });

  it('prefers an explicit original-text preview over the stored copy', () => {
    render(
      <FileContainer
        file={textFile({ text: 'Stored transformed text' })}
        textPreview="Original paste"
      />,
    );

    expect(screen.getByText('Original paste')).toBeInTheDocument();
    expect(screen.queryByText('Stored transformed text')).not.toBeInTheDocument();
  });

  it('updates the snippet when the attachment text changes', () => {
    const { rerender } = render(<FileContainer file={textFile({ text: 'First paste' })} />);

    rerender(<FileContainer file={textFile({ text: 'Edited paste' })} />);

    expect(screen.getByText('Edited paste')).toBeInTheDocument();
    expect(screen.queryByText('First paste')).not.toBeInTheDocument();
  });

  it('does not infer content from a pasted-text filename', () => {
    render(<FileContainer file={textFile()} />);

    expect(screen.getByTestId('file-preview')).toBeInTheDocument();
    expect(screen.getByText('Plain')).toBeInTheDocument();
  });

  it('allows callers to disable a stored preview', () => {
    render(<FileContainer file={textFile({ text: 'Deliberate upload' })} textPreview={null} />);

    expect(screen.queryByText('Deliberate upload')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-preview')).toBeInTheDocument();
  });

  it.each([
    { type: 'application/pdf', text: 'Extracted document text' },
    { type: 'text/html', text: '<p>HTML document</p>' },
    { type: 'text/plain', textFormat: 'html' as const, text: '<p>HTML preview</p>' },
  ])('leaves non-plain-text previews on the ordinary card: %j', (file) => {
    render(<FileContainer file={baseFile(file)} />);

    expect(screen.queryByText(file.text)).not.toBeInTheDocument();
    expect(screen.getByTestId('file-preview')).toBeInTheDocument();
  });

  it.each(['', ' \n\t '])('falls back to the file tile for empty content: %j', (text) => {
    render(<FileContainer file={textFile({ text })} />);

    expect(screen.getByTestId('file-preview')).toBeInTheDocument();
    expect(screen.getByText('Plain')).toBeInTheDocument();
  });

  it('bounds the rendered snippet without changing the original content', () => {
    const file = textFile({ text: 'a'.repeat(10000) });
    render(<FileContainer file={file} />);

    expect(screen.getByText('a'.repeat(240))).toBeInTheDocument();
    expect(file.text).toHaveLength(10000);
  });

  it('skips leading blank space before bounding the snippet', () => {
    render(<FileContainer file={textFile({ text: `${'\n'.repeat(300)}Actual pasted content` })} />);

    expect(screen.getByText('Actual pasted content')).toBeInTheDocument();
    expect(screen.queryByTestId('file-preview')).not.toBeInTheDocument();
  });

  it('renders pasted markup as text, not HTML', () => {
    const text = '<img src=x onerror="alert(1)">';
    const { container } = render(<FileContainer file={textFile({ text })} />);

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('preserves explicit subtitle content alongside the snippet', () => {
    render(<FileContainer file={textFile({ text: 'Actual content' })} subtitle="Preview status" />);

    expect(screen.getByText('Actual content')).toBeInTheDocument();
    expect(screen.getByText('Preview status')).toBeInTheDocument();
  });

  it('keeps edit and move controls independently keyboard accessible beside the snippet', async () => {
    const onEdit = jest.fn();
    const onMove = jest.fn();
    const { container } = render(
      <FileContainer
        file={textFile({ text: 'Actual content' })}
        onClick={onEdit}
        ariaLabel="Edit pasted text"
        subtitleAction={{ label: 'Move back into message', onClick: onMove }}
      />,
    );

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Edit pasted text' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Move back into message' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Actual content')).toBeInTheDocument();
    expect(container.querySelector('button button')).toBeNull();
  });

  it('keeps a themed loading indicator during upload without restoring the icon tile', () => {
    const file = { ...textFile({ text: 'Uploading clipboard content' }), progress: 0.4 };
    const { container, rerender } = render(<FileContainer file={file} />);

    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(container.querySelector('svg.spinner')).toHaveClass('size-3');
    expect(screen.queryByTestId('file-preview')).not.toBeInTheDocument();

    rerender(<FileContainer file={{ ...file, progress: 1 }} />);

    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector('svg.spinner')).toBeNull();
  });
});
