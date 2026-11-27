import { render, screen } from '@testing-library/react';
import ImageResize from '../../SettingsTabs/Chat/ImageResize';

const mockSetUserPreference = jest.fn();
let mockResizeState = {
  isEnabled: true,
  isEnforced: false,
  isSupported: true,
  isConfigPending: false,
  isConfigUnavailable: false,
};

jest.mock('recoil', () => ({
  useSetRecoilState: () => mockSetUserPreference,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { clientImageResize: { key: 'clientImageResize' } },
}));

jest.mock('~/hooks', () => ({
  useClientResize: () => mockResizeState,
  useLocalize: () => (key: string) => key,
}));

describe('ImageResize', () => {
  beforeEach(() => {
    mockResizeState = {
      isEnabled: true,
      isEnforced: false,
      isSupported: true,
      isConfigPending: false,
      isConfigUnavailable: false,
    };
  });

  it('keeps the supported user setting interactive', () => {
    render(<ImageResize />);

    expect(screen.getByTestId('clientImageResize')).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'com_nav_info_client_image_resize' }),
    ).toBeInTheDocument();
  });

  it('disables the setting and explains when client resizing is unsupported', () => {
    mockResizeState.isSupported = false;

    render(<ImageResize />);

    expect(screen.getByTestId('clientImageResize')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'com_nav_info_client_image_resize_unsupported' }),
    ).toBeInTheDocument();
  });

  it('prioritizes the unsupported explanation over the enforced explanation', () => {
    mockResizeState.isSupported = false;
    mockResizeState.isEnforced = true;

    render(<ImageResize />);

    expect(screen.getByTestId('clientImageResize')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'com_nav_info_client_image_resize_unsupported' }),
    ).toBeInTheDocument();
  });

  it('disables the setting while the file config is pending', () => {
    mockResizeState.isEnabled = false;
    mockResizeState.isConfigPending = true;

    render(<ImageResize />);

    const toggle = screen.getByTestId('clientImageResize');
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-busy', 'true');
    expect(
      screen.getByRole('button', { name: 'com_nav_info_client_image_resize' }),
    ).toBeInTheDocument();
  });

  it('disables the setting and explains when the file config is unavailable', () => {
    mockResizeState.isEnabled = false;
    mockResizeState.isConfigUnavailable = true;

    render(<ImageResize />);

    expect(screen.getByTestId('clientImageResize')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'com_nav_info_client_image_resize_unavailable' }),
    ).toBeInTheDocument();
  });

  it('keeps the enforced behavior when client resizing is supported', () => {
    mockResizeState.isEnforced = true;

    render(<ImageResize />);

    expect(screen.getByTestId('clientImageResize')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'com_nav_info_client_image_resize_enforced' }),
    ).toBeInTheDocument();
  });
});
