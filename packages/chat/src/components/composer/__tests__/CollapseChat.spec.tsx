/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { initEnglish } from '../../../__fixtures__/i18n';
import CollapseChat from '../CollapseChat';

beforeAll(initEnglish);

describe('CollapseChat', () => {
  it('renders nothing while the composer does not scroll', () => {
    const { container } = render(
      <CollapseChat isScrollable={false} isCollapsed={false} setIsCollapsed={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the action it will take and toggles the collapsed state', () => {
    const setIsCollapsed = jest.fn();
    const { rerender } = render(
      <CollapseChat isScrollable isCollapsed={false} setIsCollapsed={setIsCollapsed} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Chat' }));
    const toggle = setIsCollapsed.mock.calls[0][0] as (prev: boolean) => boolean;
    expect(toggle(false)).toBe(true);

    rerender(<CollapseChat isScrollable isCollapsed setIsCollapsed={setIsCollapsed} />);
    expect(screen.getByRole('button', { name: 'Expand Chat' })).toBeInTheDocument();
  });
});
