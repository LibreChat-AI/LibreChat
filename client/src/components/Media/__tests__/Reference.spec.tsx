import React, { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { OGDialog, OGDialogContent, OGDialogTitle } from '@librechat/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { MediaReferenceUpload } from '../Reference';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

type Props = ComponentProps<typeof MediaReferenceUpload>;
function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    id: 'reference',
    ownerKey: 'first',
    hostedRoles: ['video'],
    localAccept: '',
    disabled: false,
    uploading: false,
    url: 'https://media.example.com/video.mp4',
    role: 'video',
    valid: true,
    onURLChange: jest.fn(),
    onRoleChange: jest.fn(),
    uploadURL: jest.fn().mockResolvedValue(true),
    uploadFile: jest.fn().mockResolvedValue(true),
    cancel: jest.fn(),
    ...overrides,
  };
  return props;
}

test('URL-only references are hidden until Upload opens the dialog and never offer a file chooser', async () => {
  const props = setup();
  const view = render(<MediaReferenceUpload {...props} />);
  expect(
    screen.queryByRole('textbox', { name: 'com_media_reference_url' }),
  ).not.toBeInTheDocument();
  expect(view.container.querySelector('input[type=file]')).toBeNull();
  const trigger = screen.getByRole('button', { name: 'com_media_upload' });
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'com_media_upload' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'com_media_reference_url' })).toHaveValue(props.url);
  expect(
    screen.queryByRole('button', { name: 'com_media_local_reference' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(props.uploadURL).not.toHaveBeenCalled();
});

test('mixed references open the dialog first and offer only supported local file types', async () => {
  const props = setup({ hostedRoles: ['video'], localAccept: 'image/*,audio/*' });
  const view = render(<MediaReferenceUpload {...props} />);
  const input = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
  const choose = jest.spyOn(input, 'click');
  expect(input).toHaveAttribute('accept', 'image/*,audio/*');
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  expect(choose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_local_reference' }));
  expect(choose).toHaveBeenCalledTimes(1);
  const file = new File(['sound'], 'audio.mp3', { type: 'audio/mpeg' });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(props.uploadFile).toHaveBeenCalledWith(file);
  expect(props.uploadURL).not.toHaveBeenCalled();
});

test('file-only references keep the native chooser and cancellation permits retry before an old request settles', async () => {
  let complete!: (value: boolean) => void;
  const uploadFile = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue(true);
  const props = setup({ hostedRoles: [], localAccept: 'image/*,video/*,audio/*', uploadFile });
  const view = render(<MediaReferenceUpload {...props} />);
  const input = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
  const choose = jest.spyOn(input, 'click');
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  expect(choose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  const file = new File(['image'], 'image.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  view.rerender(<MediaReferenceUpload {...props} uploading />);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  view.rerender(<MediaReferenceUpload {...props} uploading={false} />);
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
  await act(async () => complete(false));
});

test('Enter submits once without navigation, preserves a failed draft, and closes only on successful retry', async () => {
  const user = userEvent.setup();
  let complete!: (value: boolean) => void;
  const uploadURL = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue(true);
  const props = setup({ uploadURL });
  const view = render(<MediaReferenceUpload {...props} />);
  const location = window.location.href;
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  const url = screen.getByRole('textbox', { name: 'com_media_reference_url' });
  await user.click(url);
  await user.keyboard('{Enter}{Enter}');
  expect(uploadURL).toHaveBeenCalledTimes(1);
  expect(window.location.href).toBe(location);
  await act(async () => complete(false));
  view.rerender(<MediaReferenceUpload {...props} error="com_media_error_reference_unavailable" />);
  expect(screen.getByRole('alert')).toHaveTextContent('com_media_error_reference_unavailable');
  expect(url).toHaveValue(props.url);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(uploadURL).toHaveBeenCalledTimes(2);
});

test('cancelling and reopening ignores completion from the abandoned import', async () => {
  let complete!: (value: boolean) => void;
  const uploadURL = jest
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue(true);
  const props = setup({ uploadURL });
  render(<MediaReferenceUpload {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_media_add_reference_url' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  await act(async () => complete(true));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'com_media_add_reference_url' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(uploadURL).toHaveBeenCalledTimes(2);
});

test.each(['owner', 'capabilities'] as const)(
  'changing %s closes and cancels without reopening when restored',
  (change) => {
    const props = setup();
    const view = render(<MediaReferenceUpload {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
    const changed = change === 'owner' ? { ownerKey: 'second' } : { hostedRoles: [] };
    view.rerender(<MediaReferenceUpload {...props} {...changed} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(props.cancel).toHaveBeenCalled();
    view.rerender(<MediaReferenceUpload {...props} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  },
);

test('the role menu and reference dialog dismiss in order inside a parent dialog', async () => {
  const user = userEvent.setup();
  function Nested() {
    const [parentOpen, setParentOpen] = useState(true);
    return (
      <OGDialog open={parentOpen} onOpenChange={setParentOpen}>
        <OGDialogContent aria-describedby={undefined}>
          <OGDialogTitle>{'Parent settings'}</OGDialogTitle>
          <MediaReferenceUpload
            {...setup({ hostedRoles: ['audio', 'video'], localAccept: 'image/*' })}
          />
        </OGDialogContent>
      </OGDialog>
    );
  }
  render(<Nested />);
  fireEvent.click(screen.getByRole('button', { name: 'com_media_upload' }));
  const dialog = screen.getByRole('dialog', { name: 'com_media_upload' });
  expect(dialog).toHaveClass('overflow-y-auto');
  const roles = within(dialog).getByRole('combobox', { name: 'com_media_reference_url_role' });
  fireEvent.click(roles);
  await screen.findByRole('option', { name: 'com_media_role_audio' });
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog', { name: 'com_media_upload' })).toBeInTheDocument();
  await waitFor(() => expect(roles).toHaveFocus());
  await user.keyboard('{Escape}');
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'com_media_upload' })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole('dialog', { name: 'Parent settings' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'com_media_upload' })).toHaveFocus();
});
