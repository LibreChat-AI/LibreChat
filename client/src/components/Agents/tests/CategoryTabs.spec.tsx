import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type t from 'librechat-data-provider';
import CategoryTabs from '../CategoryTabs';

// Mock useLocalize hook
jest.mock('~/hooks/useLocalize', () => () => (key: string) => {
  const mockTranslations: Record<string, string> = {
    com_agents_top_picks: 'Top Picks',
    com_agents_all: 'All Agents',
    com_agents_all_category: 'All',
    com_ui_no_categories: 'No categories available',
    com_agents_category_tabs_label: 'Agent Categories',
    com_ui_agent_category_general: 'General',
    com_ui_agent_category_hr: 'HR',
    com_ui_agent_category_rd: 'R&D',
    com_ui_agent_category_finance: 'Finance',
    com_ui_agent_category_it: 'IT',
    com_ui_agent_category_sales: 'Sales',
    com_ui_agent_category_aftersales: 'After Sales',
  };
  return mockTranslations[key] || key;
});

describe('CategoryTabs', () => {
  const mockCategories: t.TMarketplaceCategory[] = [
    { value: 'promoted', label: 'Top Picks', description: 'Our recommended agents', count: 5 },
    { value: 'all', label: 'All', description: 'All available agents', count: 20 },
    { value: 'general', label: 'General', description: 'General purpose agents', count: 8 },
    { value: 'hr', label: 'HR', description: 'HR agents', count: 3 },
    { value: 'finance', label: 'Finance', description: 'Finance agents', count: 4 },
  ];

  const mockOnChange = jest.fn();
  const user = userEvent.setup();

  beforeEach(() => {
    mockOnChange.mockClear();
  });

  it('renders provided categories', () => {
    render(
      <CategoryTabs
        categories={mockCategories}
        activeTab="promoted"
        isLoading={false}
        onChange={mockOnChange}
      />,
    );

    // Check for provided categories
    expect(screen.getByText('Top Picks')).toBeInTheDocument();
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('HR')).toBeInTheDocument();
    expect(screen.getByText('Finance')).toBeInTheDocument();
  });

  it('handles loading state properly', () => {
    render(
      <CategoryTabs
        categories={[]}
        activeTab="promoted"
        isLoading={true}
        onChange={mockOnChange}
      />,
    );

    // SmartLoader should handle loading behavior correctly
    // The component should render without crashing during loading
    expect(screen.queryByText('No categories available')).not.toBeInTheDocument();
  });

  it('marks the active tab as selected', () => {
    render(
      <CategoryTabs
        categories={mockCategories}
        activeTab="general"
        isLoading={false}
        onChange={mockOnChange}
      />,
    );

    const generalTab = screen.getByText('General').closest('button');
    expect(generalTab).toHaveAttribute('aria-selected', 'true');
  });

  it('calls onChange when a tab is clicked', async () => {
    render(
      <CategoryTabs
        categories={mockCategories}
        activeTab="promoted"
        isLoading={false}
        onChange={mockOnChange}
      />,
    );

    const hrTab = screen.getByText('HR');
    await user.click(hrTab);

    expect(mockOnChange).toHaveBeenCalledWith('hr');
  });

  it('handles promoted tab click correctly', async () => {
    render(
      <CategoryTabs
        categories={mockCategories}
        activeTab="general"
        isLoading={false}
        onChange={mockOnChange}
      />,
    );

    const topPicksTab = screen.getByText('Top Picks');
    await user.click(topPicksTab);

    expect(mockOnChange).toHaveBeenCalledWith('promoted');
  });

  it('handles all tab click correctly', async () => {
    render(
      <CategoryTabs
        categories={mockCategories}
        activeTab="promoted"
        isLoading={false}
        onChange={mockOnChange}
      />,
    );

    const allTab = screen.getByText('All');
    await user.click(allTab);

    expect(mockOnChange).toHaveBeenCalledWith('all');
  });

  it('marks the selected tab and leaves other tabs unselected', () => {
    render(
      <CategoryTabs
        categories={mockCategories}
        activeTab="promoted"
        isLoading={false}
        onChange={mockOnChange}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[2]).toHaveAttribute('aria-selected', 'false');
  });

  it('renders accessible tabs connected to category panels', () => {
    render(
      <CategoryTabs
        categories={mockCategories}
        activeTab="promoted"
        isLoading={false}
        onChange={mockOnChange}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    tabs.forEach((tab) => {
      expect(tab.tagName).toBe('BUTTON');
      expect(tab.getAttribute('aria-controls')).toMatch(/^category-panel-/);
    });
  });

  it('handles keyboard navigation', async () => {
    render(
      <CategoryTabs
        categories={mockCategories}
        activeTab="promoted"
        isLoading={false}
        onChange={mockOnChange}
      />,
    );

    const generalTab = screen.getByText('General').closest('button')!;

    // Focus the button and click it
    generalTab.focus();
    expect(document.activeElement).toBe(generalTab);

    await user.click(generalTab);
    expect(mockOnChange).toHaveBeenCalledWith('general');
  });

  it('shows empty state when categories prop is empty', () => {
    render(
      <CategoryTabs
        categories={[]}
        activeTab="promoted"
        isLoading={false}
        onChange={mockOnChange}
      />,
    );

    // Should show empty state message (localized)
    expect(screen.getByText('No categories available')).toBeInTheDocument();
  });

  it('maintains consistent ordering of categories', () => {
    render(
      <CategoryTabs
        categories={mockCategories}
        activeTab="promoted"
        isLoading={false}
        onChange={mockOnChange}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    const tabTexts = tabs.map((tab) => tab.textContent);

    // Check that promoted is first and all is second
    expect(tabTexts[0]).toBe('Top Picks');
    expect(tabTexts[1]).toBe('All');
    expect(tabTexts.length).toBe(5);
  });
});
