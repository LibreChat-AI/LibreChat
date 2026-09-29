import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { TFile } from 'librechat-data-provider';
import FileContainer from '../FileContainer';

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getFileType: () => ({ paths: [], color: '', title: 'Plain' }),
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
