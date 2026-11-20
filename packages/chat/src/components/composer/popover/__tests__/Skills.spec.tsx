/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SkillsPopoverProps } from '../Skills';
import type { CommandOption } from '../Command';
import SkillsPopover from '../Skills';

/**
 * The `$` popover's contract: text after the `$` stays in the draft, a pick goes to the host and
 * never into the text, Enter and Tab on a skill are consumed, and an empty, unmatched or failed
 * list says so in a status message.
 */

const skills: CommandOption[] = [
  { type: 'skill', value: 'brand-guidelines', label: 'Brand Guidelines' },
  { type: 'skill', value: 'style-guide', label: 'Style Guide' },
];

const notices = { error: 'Load failed', empty: 'No skills yet', noMatch: 'No match' };

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

const renderSkills = (props: Partial<SkillsPopoverProps> = {}, draft = '$') => {
  const textarea = document.createElement('textarea');
  textarea.value = draft;
  document.body.appendChild(textarea);
  textarea.setSelectionRange(1, 1);
  const onClose = jest.fn();
  const onSelectSkill = jest.fn();
  render(
    <SkillsPopover
      textAreaRef={{ current: textarea }}
      placeholder="Skills"
      skills={skills}
      isLoading={false}
      isError={false}
      notices={notices}
      onClose={onClose}
      onSelectSkill={onSelectSkill}
      {...props}
    />,
  );
  return { textarea, onClose, onSelectSkill };
};

const input = () => screen.getByRole('combobox');

describe('SkillsPopover', () => {
  it('keeps the text after the cursor in the draft and hands the pick to the host', () => {
    const { textarea, onClose, onSelectSkill } = renderSkills({}, '$ please review');

    expect(textarea.value).toBe(' please review');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(fireEvent.keyDown(input(), { key: 'Tab' })).toBe(false);

    expect(onClose).toHaveBeenCalled();
    expect(onSelectSkill).toHaveBeenCalledWith(skills[1]);
    expect(textarea.value).toBe(' please review');
    expect(document.activeElement).toBe(textarea);
  });

  it('lets Tab move on but consumes Enter when nothing matches', () => {
    renderSkills();
    fireEvent.change(input(), { target: { value: 'zzz' } });

    expect(screen.getByRole('status')).toHaveTextContent('No match');
    expect(fireEvent.keyDown(input(), { key: 'Tab' })).toBe(true);
  });

  it('consumes Enter when nothing matches and closes', () => {
    const { onClose } = renderSkills();
    fireEvent.change(input(), { target: { value: 'zzz' } });

    expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it('says when there are no skills', () => {
    renderSkills({ skills: [] });
    expect(screen.getByRole('status')).toHaveTextContent('No skills yet');
  });

  it('says when the skills failed to load, keeping any already listed', () => {
    renderSkills({ isError: true });
    expect(screen.getByRole('status')).toHaveTextContent('Load failed');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('shows no notice while the catalog is still loading', () => {
    renderSkills({ skills: [], isLoading: true });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
