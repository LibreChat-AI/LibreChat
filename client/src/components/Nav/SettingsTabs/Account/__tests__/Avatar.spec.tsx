import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor } from 'test/layout-test-utils';
import Avatar from '../Avatar';

const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetFileConfig: () => ({ data: { avatarSizeLimit: 2 * 1024 * 1024 } }),
  useUploadAvatarMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));

describe('Avatar upload dialog', () => {
  beforeEach(() => {
    mockShowToast.mockClear();
  });

  const openDialog = async () => {
    render(<Avatar />);
    await userEvent.click(screen.getByRole('button', { name: 'Change picture' }));
  };

  it('shows avatar-specific guidance and the configured size unit', async () => {
    await openDialog();

    expect(screen.getByText('Drop an image here to use as your profile picture')).toBeVisible();
    expect(screen.getByText('PNG, JPG, or JPEG, up to 2 MB')).toBeVisible();
    expect(screen.getByLabelText('File input for avatar')).toHaveAttribute(
      'accept',
      '.png, .jpg, .jpeg',
    );
  });

  it('closes from the top-right dialog close button', async () => {
    await openDialog();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Upload an image' })).not.toBeInTheDocument();
    });
  });

  it('rejects a dropped file outside the advertised image formats', async () => {
    await openDialog();
    const dropTarget = screen.getByText(
      'Drop an image here to use as your profile picture',
    ).parentElement;
    const unsupportedFile = new File(['gif'], 'avatar.gif', { type: 'image/gif' });

    fireEvent.drop(dropTarget as HTMLElement, {
      dataTransfer: { files: [unsupportedFile] },
    });

    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'Choose a PNG, JPG, or JPEG image up to 2 MB',
      status: 'error',
    });
  });
});
