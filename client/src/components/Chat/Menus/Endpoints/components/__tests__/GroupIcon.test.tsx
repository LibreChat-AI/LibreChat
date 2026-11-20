import { render, screen } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import GroupIcon from '../GroupIcon';

describe('GroupIcon', () => {
  it('renders built-in endpoint icon keys', () => {
    render(<GroupIcon iconURL="openAI" groupName="OpenAI" />);

    expect(screen.getByRole('img', { name: 'OpenAI' })).toBeInTheDocument();
  });

  it('keeps the agents mark for an agents group icon', () => {
    const { container } = render(
      <GroupIcon iconURL={EModelEndpoint.agents} groupName="My Agents" />,
    );

    expect(screen.queryByRole('img', { name: 'Custom' })).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByTitle('My Agents')).toBeInTheDocument();
  });

  it('resolves known endpoint asset aliases case-insensitively', () => {
    render(<GroupIcon iconURL="OpenRouter" groupName="OpenRouter" />);

    expect(screen.getByRole('img', { name: 'OpenRouter' })).toBeInTheDocument();
  });

  it('resolves the Lemonade alias to its mark', () => {
    render(<GroupIcon iconURL="Lemonade" groupName="Lemonade" />);

    const icon = screen.getByRole('img', { name: 'AMD Lemonade' });
    expect(icon).not.toHaveAttribute('src');
    expect(icon.querySelector('svg')).toHaveAttribute('fill', 'currentColor');
  });

  it('renders known endpoint aliases backed by components', () => {
    render(<GroupIcon iconURL="Moonshot" groupName="Moonshot" />);

    expect(screen.getByRole('img', { name: 'Moonshot' })).toBeInTheDocument();
  });

  it('renders configured image URLs directly', () => {
    render(<GroupIcon iconURL="/assets/openrouter.png" groupName="OpenRouter" />);

    expect(screen.getByRole('img', { name: 'OpenRouter' })).toHaveAttribute(
      'src',
      '/assets/openrouter.png',
    );
  });
});
