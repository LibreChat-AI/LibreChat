import React from 'react';
import axe from 'axe-core';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import AgentCertification from '../AgentCertification';

const mockMutate = jest.fn();
const mockShowToast = jest.fn();
let mockCanManage = true;
let mockIsLoading = false;
let mockMutationOptions: {
  onSuccess?: (result: { id: string; is_certified: boolean }) => void;
  onError?: () => void;
} = {};

const translations: Record<string, string> = {
  com_ui_certification: 'Certification',
  com_ui_certified_agent: 'Certified',
  com_ui_certify: 'Certify',
  com_ui_uncertify: 'Remove certification',
  com_ui_certify_agent: 'Certify this agent',
  com_ui_uncertify_agent: 'Remove certification',
  com_ui_certify_agent_confirm: 'Are you sure you want to certify this agent?',
  com_ui_uncertify_agent_confirm: 'Are you sure you want to remove certification?',
  com_ui_agent_certified_success: 'Agent certified',
  com_ui_agent_uncertified_success: 'Certification removed',
  com_ui_agent_certification_error: 'Could not update certification. Try again.',
  com_ui_cancel: 'Cancel',
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => translations[key] ?? key,
  useAgentCertification: () => ({
    enabled: true,
    description: 'Reviewed by the AI governance board.',
    canManage: mockCanManage,
  }),
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/data-provider', () => ({
  useSetAgentCertificationMutation: (options: typeof mockMutationOptions) => {
    mockMutationOptions = options;
    return { mutate: mockMutate, isLoading: mockIsLoading };
  },
}));

/** Scans with axe-core directly; `region` is a page-level rule a fragment cannot satisfy. */
async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, { rules: { region: { enabled: false } } });
  return results.violations.map((v) => `${v.id}: ${v.help}`);
}

describe('AgentCertification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanManage = true;
    mockIsLoading = false;
  });

  it('renders nothing for a user without manage:agents', () => {
    mockCanManage = false;
    const { container } = render(<AgentCertification agentId="agent_1" isCertified={false} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('asks before certifying and saves only on confirm', async () => {
    const user = userEvent.setup();
    render(<AgentCertification agentId="agent_1" isCertified={false} />);

    const checkbox = screen.getByRole('checkbox', { name: 'Certify this agent' });
    expect(checkbox).toHaveAccessibleDescription('Reviewed by the AI governance board.');
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Are you sure you want to certify this agent?');
    expect(mockMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Certify' }));
    expect(mockMutate).toHaveBeenCalledWith({ agent_id: 'agent_1', is_certified: true });
  });

  it('cancelling leaves the agent untouched and returns focus to the checkbox', async () => {
    const user = userEvent.setup();
    render(<AgentCertification agentId="agent_1" isCertified />);

    const checkbox = screen.getByRole('checkbox', { name: /Certify this agent/ });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Are you sure you want to remove certification?',
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockMutate).not.toHaveBeenCalled();
    await waitFor(() => expect(checkbox).toHaveFocus());
  });

  it('confirms the result and reports a failure', () => {
    render(<AgentCertification agentId="agent_1" isCertified={false} />);

    mockMutationOptions.onSuccess?.({ id: 'agent_1', is_certified: false });
    expect(mockShowToast).toHaveBeenLastCalledWith({
      message: 'Certification removed',
      status: 'success',
    });

    mockMutationOptions.onError?.();
    expect(mockShowToast).toHaveBeenLastCalledWith({
      message: 'Could not update certification. Try again.',
      status: 'error',
    });
  });

  it('disables the checkbox while a change is saving', () => {
    mockIsLoading = true;
    render(<AgentCertification agentId="agent_1" isCertified={false} />);

    expect(screen.getByRole('checkbox', { name: 'Certify this agent' })).toBeDisabled();
  });

  it('has no detectable accessibility violations, closed or confirming', async () => {
    const user = userEvent.setup();
    const { container } = render(<AgentCertification agentId="agent_1" isCertified />);

    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole('checkbox', { name: /Certify this agent/ }));
    expect(await axeViolations(await screen.findByRole('dialog'))).toEqual([]);
  });
});
