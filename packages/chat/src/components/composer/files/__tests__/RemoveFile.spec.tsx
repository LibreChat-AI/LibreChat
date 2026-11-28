/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { initEnglish } from '../../../../__fixtures__/i18n';
import RemoveFile from '../RemoveFile';

beforeAll(initEnglish);

describe('RemoveFile', () => {
  it('names the file it removes, or falls back to the generic label', () => {
    const onRemove = jest.fn();
    const { rerender } = render(<RemoveFile onRemove={onRemove} label="Remove report.pdf" />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove report.pdf' }));
    expect(onRemove).toHaveBeenCalledTimes(1);

    rerender(<RemoveFile onRemove={onRemove} disabled />);
    expect(screen.getByRole('button', { name: 'Remove file' })).toBeDisabled();
  });
});
