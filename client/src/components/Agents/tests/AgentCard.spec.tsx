import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type t from 'librechat-data-provider';
import AgentCard from '../AgentCard';

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils/agents'),
  cn: (...classes: Array<string | false | undefined | null>) => classes.filter(Boolean).join(' '),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const labels: Record<string, string> = {
      com_ui_agent: 'Agent',
      com_agents_category_general: 'General',
      com_agents_description_empty: 'No description provided.',
      com_agents_view_details: 'View details',
      com_agents_contact: 'Contact',
      com_agents_no_contact_available: 'No contact available',
    };
    return labels[key] ?? key;
  },
  useAgentCategories: () => ({
    categories: [{ value: 'general', label: 'com_agents_category_general' }],
  }),
}));

const agent: t.Agent = {
  id: 'agent-one',
  name: 'Research Assistant',
  description: 'Find clear answers and compare sources.',
  category: 'general',
  support_contact: { name: 'Research Team', email: 'support@example.com' },
  avatar: null,
  created_at: 0,
  provider: 'openai',
  model: 'gpt-4',
  model_parameters: {
    temperature: null,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
};

describe('AgentCard', () => {
  it('shows the public identity and keeps its support link independent', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(<AgentCard agent={agent} onSelect={onSelect} />);
    expect(screen.getByRole('heading', { name: agent.name as string })).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: agent.name as string });
    expect(trigger).toHaveAccessibleDescription(agent.description as string);
    const contact = screen.getByRole('link', { name: 'Research Team' });
    expect(contact).toHaveAttribute('href', 'mailto:support@example.com');
    contact.addEventListener('click', (event) => event.preventDefault());
    await user.click(contact);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('strips markup from a rich description so the blurb stays text', () => {
    render(
      <AgentCard
        agent={{
          ...agent,
          support_contact: undefined,
          description:
            '<span>Assistant for projects. <a href="https://example.com">Read the guide</a></span>',
        }}
        onSelect={jest.fn()}
      />,
    );

    expect(screen.getByText('Assistant for projects. Read the guide')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Read the guide' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: agent.name as string })).toHaveAccessibleDescription(
      'Assistant for projects. Read the guide',
    );
  });

  it('selects the agent exactly once on click', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(<AgentCard agent={agent} onSelect={onSelect} />);
    const trigger = screen.getByRole('button', { name: agent.name as string });
    await user.click(trigger);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(agent);
  });

  it.each(['{Enter}', ' '])('uses native keyboard activation for %s', async (key) => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(<AgentCard agent={agent} onSelect={onSelect} />);
    await user.tab();
    expect(screen.getByRole('button', { name: agent.name as string })).toHaveFocus();
    await user.keyboard(key);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('keeps cards usable when their avatar fails to load', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(
      <AgentCard
        onSelect={onSelect}
        agent={{ ...agent, avatar: { filepath: '/missing-avatar.png', source: 'local' } }}
      />,
    );
    const image = screen.getByRole('img', { name: 'Research Assistant avatar' });
    fireEvent.error(image);
    expect(image).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: agent.name as string }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: agent.id }));
  });

  it('keeps accessible labels distinct when the same agent appears twice', () => {
    render(
      <>
        <AgentCard agent={agent} onSelect={jest.fn()} />
        <AgentCard
          onSelect={jest.fn()}
          agent={{ ...agent, name: 'Second appearance', description: 'A different summary' }}
        />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Research Assistant' })).toHaveAccessibleDescription(
      'Find clear answers and compare sources.',
    );
    expect(screen.getByRole('button', { name: 'Second appearance' })).toHaveAccessibleDescription(
      'A different summary',
    );
  });

  it('offers details without inventing missing metadata', async () => {
    const user = userEvent.setup();
    const onSelect = jest.fn();
    render(
      <AgentCard
        onSelect={onSelect}
        agent={{
          ...agent,
          name: null,
          description: null,
          category: undefined,
          support_contact: undefined,
        }}
      />,
    );
    expect(screen.queryByText('General')).not.toBeInTheDocument();
    expect(screen.queryByText('No contact available')).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Agent' });
    expect(trigger).toHaveAccessibleDescription('No description provided.');
    await user.click(trigger);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: agent.id, name: null }));
  });
});
