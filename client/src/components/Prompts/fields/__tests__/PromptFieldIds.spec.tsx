import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { render, screen } from '@testing-library/react';
import Description from '../Description';
import Command from '../Command';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

function PromptFields() {
  return (
    <>
      <Description />
      <Command />
    </>
  );
}

describe('prompt field IDs', () => {
  it('associates every label with one field when multiple forms are mounted', () => {
    const { container } = render(
      <>
        <PromptFields />
        <PromptFields />
      </>,
    );
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];

    expect(new Set(inputs.map((input) => input.id)).size).toBe(inputs.length);

    for (const label of container.querySelectorAll('label')) {
      expect(inputs.filter((input) => input.id === label.htmlFor)).toHaveLength(1);
    }
  });
});
