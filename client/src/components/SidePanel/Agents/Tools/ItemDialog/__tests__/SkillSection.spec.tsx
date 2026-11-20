import { render, screen, fireEvent } from '@testing-library/react';
import type { SkillItem } from '../../items/types';
import { useGetSkillByIdQuery } from '~/data-provider';
import SkillSection from '../sections/SkillSection';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/data-provider', () => ({ useGetSkillByIdQuery: jest.fn() }));
jest.mock('~/components/Skills/display/SkillMarkdownRenderer', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div data-testid="skill-body">{content}</div>,
}));

const item = {
  id: 'skill-1',
  kind: 'skill',
  name: 'release-notes',
  description: 'Drafts release notes from merged pull requests.',
  skill: { _id: 'skill-1' },
} as unknown as SkillItem;

const query = (value: Record<string, unknown>) =>
  jest.mocked(useGetSkillByIdQuery).mockReturnValue(value as never);

describe('SkillSection', () => {
  it('shows the skill instructions without their frontmatter, not the identifier', () => {
    query({ data: { body: '---\nname: release-notes\n---\n# Steps\nCollect merged PRs.' } });
    render(<SkillSection item={item} />);
    expect(screen.getByTestId('skill-body')).toHaveTextContent('# Steps');
    expect(screen.getByTestId('skill-body')).not.toHaveTextContent('name: release-notes');
    expect(screen.getByText(item.description)).toBeInTheDocument();
    expect(screen.queryByText('skill-1')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_tools_info_identifier')).not.toBeInTheDocument();
  });

  it('says it is loading while the full skill is fetched', () => {
    query({ isLoading: true });
    render(<SkillSection item={item} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-body')).not.toBeInTheDocument();
  });

  it('offers a retry when the skill cannot be loaded', () => {
    const refetch = jest.fn();
    query({ isError: true, refetch });
    render(<SkillSection item={item} />);
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_skill_content_error');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
