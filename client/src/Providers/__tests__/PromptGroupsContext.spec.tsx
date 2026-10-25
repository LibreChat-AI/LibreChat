/**
 * Covers the `select` mapping in `PromptGroupsProvider`: a Langfuse-sourced
 * group (pointer-only, no `productionPrompt`) renders as a `Cloud` icon with
 * its bare name and a "Managed in Langfuse" description, so `MentionItem`
 * shows the source instead of unresolved content; a native group keeps the
 * existing oneliner/production-text label and category icon.
 */
import React from 'react';
import { Cloud } from 'lucide-react';
import { render, screen } from '@testing-library/react';
import type { TPromptGroup } from 'librechat-data-provider';

jest.mock('~/hooks', () => ({
  usePromptGroupsNav: () => ({}),
  useHasAccess: () => true,
  useCatalogReady: () => true,
  activateCatalog: jest.fn(),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Prompts', () => ({
  CategoryIcon: () => <span data-testid="category-icon" />,
}));

const mockSampleGroups: TPromptGroup[] = [
  {
    _id: 'native-1',
    name: 'Native Group',
    source: 'native',
    command: 'native-cmd',
    productionPrompt: { prompt: 'Hello there' },
  } as TPromptGroup,
  {
    _id: 'lf-1',
    name: 'Langfuse Group',
    source: 'langfuse',
    sourcePromptName: 'lf-prompt',
  } as TPromptGroup,
];

let mockCapturedSelect: ((data: TPromptGroup[]) => unknown) | undefined;

jest.mock('~/data-provider', () => ({
  useGetAllPromptGroups: (
    _params: unknown,
    options: { select: (data: TPromptGroup[]) => unknown },
  ) => {
    mockCapturedSelect = options.select;
    return { data: options.select(mockSampleGroups), isLoading: false };
  },
}));

/* Imported last, after every mock-supporting const above: the module these
   bind to is required transitively (via `~/data-provider`/`~/components/Prompts`/
   `~/hooks`) as soon as this import runs, so the mocks it reaches into must
   already be initialized. */
import { PromptGroupsProvider, usePromptGroupsContext } from '../PromptGroupsContext';

function Consumer() {
  const ctx = usePromptGroupsContext();
  const groups = ctx?.allPromptGroups.data?.promptGroups ?? [];
  return (
    <ul>
      {groups.map((group) => (
        <li key={group.id}>
          <span data-testid={`icon-${group.id}`}>
            {React.isValidElement(group.icon) && group.icon.type === Cloud ? 'cloud' : 'category'}
          </span>
          <span data-testid={`label-${group.id}`}>{group.label}</span>
          <span data-testid={`description-${group.id}`}>{group.description ?? ''}</span>
        </li>
      ))}
    </ul>
  );
}

const renderProvider = () =>
  render(
    <PromptGroupsProvider>
      <Consumer />
    </PromptGroupsProvider>,
  );

describe('PromptGroupsContext select mapping', () => {
  beforeEach(() => {
    mockCapturedSelect = undefined;
  });

  it('gives a Langfuse group a Cloud icon, its bare name, and a source description', () => {
    renderProvider();
    expect(mockCapturedSelect).toBeDefined();
    expect(screen.getByTestId('icon-lf-1')).toHaveTextContent('cloud');
    expect(screen.getByTestId('label-lf-1')).toHaveTextContent('Langfuse Group');
    expect(screen.getByTestId('description-lf-1')).toHaveTextContent(
      'com_ui_prompt_source_langfuse',
    );
  });

  it('leaves a native group label, description, and icon unchanged', () => {
    renderProvider();
    expect(screen.getByTestId('icon-native-1')).toHaveTextContent('category');
    expect(screen.getByTestId('label-native-1')).toHaveTextContent(
      '/native-cmd - Native Group: Hello there',
    );
    expect(screen.getByTestId('description-native-1')).toHaveTextContent('');
  });
});
