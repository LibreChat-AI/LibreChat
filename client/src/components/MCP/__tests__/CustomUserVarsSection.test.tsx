import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import CustomUserVarsSection from '../CustomUserVarsSection';

jest.mock('~/data-provider/Tools/queries', () => ({
  useMCPAuthValuesQuery: () => ({ data: { authValueFlags: {} } }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('CustomUserVarsSection', () => {
  const fields = {
    api_key: { title: 'My API Key', description: 'Your API key' },
  };

  it('renders autofill-prevention attributes on credential inputs', () => {
    render(
      <CustomUserVarsSection
        serverName="test-server"
        fields={fields}
        onSave={jest.fn()}
        onRevoke={jest.fn()}
      />,
    );

    const input = screen.getByLabelText(/My API Key/);
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('data-lpignore', 'true');
    expect(input).toHaveAttribute('data-1p-ignore', 'true');
  });

  it('marks optional variables in the label and leaves required ones unmarked', () => {
    render(
      <CustomUserVarsSection
        serverName="test-server"
        fields={{
          api_key: { title: 'My API Key', description: 'Your API key' },
          own_token: {
            title: 'Own Token',
            description: 'Overrides the shared account',
            optional: true,
          },
        }}
        onSave={jest.fn()}
        onRevoke={jest.fn()}
      />,
    );

    expect(screen.getByText('Own Token').textContent).toContain('com_ui_optional');
    expect(screen.getByText('My API Key').textContent).not.toContain('com_ui_optional');
  });

  it('renders non-sensitive fields as unmasked text while keeping secrets masked', () => {
    render(
      <CustomUserVarsSection
        serverName="test-server"
        fields={{
          api_key: { title: 'My API Key', description: 'Your API key' },
          project_key: { title: 'Project Key', description: 'Your project key', sensitive: false },
        }}
        onSave={jest.fn()}
        onRevoke={jest.fn()}
      />,
    );

    expect(screen.getByLabelText(/My API Key/)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/Project Key/)).toHaveAttribute('type', 'text');
  });
});
