import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import SkillsSidePanel from '../SkillsSidePanel';

const mockFetchNextPage = jest.fn();
const mockUseNavScrolling = jest.fn((_options?: object) => ({
  containerRef: { current: null },
}));
const mockUseSkillsInfiniteQuery = jest.fn(() => ({
  data: {
    pages: [{ skills: [], has_more: true, after: 'cursor-2' }],
  },
  isFetchingNextPage: false,
  fetchNextPage: mockFetchNextPage,
  isLoading: false,
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => true,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { sidebarExpanded: {} },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useDebounce: (value: string) => value,
  useNavScrolling: (options: object) => mockUseNavScrolling(options),
}));

jest.mock('~/data-provider', () => ({
  useSkillsInfiniteQuery: () => mockUseSkillsInfiniteQuery(),
}));

jest.mock('~/components/ui', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const PanelContent = ReactModule.forwardRef<HTMLDivElement, { children?: React.ReactNode }>(
    ({ children }, ref) => <div ref={ref}>{children}</div>,
  );
  /** SkillList renders its body through Collapse, which keeps children mounted
   *  and marks them hidden when closed rather than unmounting them. */
  const Collapse = ({ open, children }: { open: boolean; children?: React.ReactNode }) => (
    <div aria-hidden={!open || undefined}>{children}</div>
  );
  return { PanelContent, Collapse };
});

jest.mock('../FilterSkills', () => ({
  __esModule: true,
  default: () => <div />,
}));

jest.mock('../../lists/SkillListItem', () => ({
  __esModule: true,
  default: () => null,
}));

describe('SkillsSidePanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('disables automatic pagination while My Skills is collapsed', () => {
    render(
      <MemoryRouter>
        <SkillsSidePanel />
      </MemoryRouter>,
    );

    const toggle = screen.getByRole('button', { name: 'com_ui_my_skills' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(mockUseNavScrolling).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });
});
