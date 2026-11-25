import React from 'react';
import { act, render, screen } from '@testing-library/react';
import type { JotaiStore } from 'test/harness';
import { sessionRailDocked, sessionRailSheetSlot, sessionRailSlot } from '../state';
import { ChatSurfaceHarness } from 'test/harness';
import SessionRailLayout from '../Layout';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const renderLayout = () => {
  let atoms!: JotaiStore;
  const rendered = render(
    <ChatSurfaceHarness seed={(store) => (atoms = store)}>
      <SessionRailLayout>
        <main>{'the conversation'}</main>
      </SessionRailLayout>
    </ChatSurfaceHarness>,
  );
  return { ...rendered, atoms };
};

describe('SessionRailLayout', () => {
  it('gives the conversation the whole row, and the sheet a slot, while no rail is docked', () => {
    const { atoms } = renderLayout();

    expect(screen.getByRole('main')).toHaveTextContent('the conversation');
    expect(screen.queryByTestId('session-rail-slot')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(atoms.get(sessionRailSlot)).toBeNull();
    expect(atoms.get(sessionRailSheetSlot)).toBe(screen.getByTestId('session-rail-sheet-slot'));
  });

  it('makes the rail a column with a handle while one is docked, and takes both away after', () => {
    const { atoms } = renderLayout();

    act(() => atoms.set(sessionRailDocked, true));

    const slot = screen.getByTestId('session-rail-slot');
    expect(atoms.get(sessionRailSlot)).toBe(slot);
    expect(screen.getByRole('separator')).toHaveAccessibleName('com_ui_session_resize');
    /** The conversation comes first and the rail's column after it, past the handle. */
    const column = slot.closest('[data-panel]') as HTMLElement;
    expect(column).toHaveAttribute('id', 'session-rail-column');
    expect(
      screen.getByRole('main').compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole('main')).toHaveTextContent('the conversation');

    act(() => atoms.set(sessionRailDocked, false));

    expect(screen.queryByTestId('session-rail-slot')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(atoms.get(sessionRailSlot)).toBeNull();
    expect(screen.getByRole('main')).toHaveTextContent('the conversation');
  });
});
