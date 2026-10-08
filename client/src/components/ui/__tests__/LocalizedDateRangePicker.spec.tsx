import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen } from '@testing-library/react';
import LocalizedDateRangePicker from '../LocalizedDateRangePicker';

const labels = {
  apply: 'Apply',
  cancel: 'Cancel',
  endDate: 'End date',
  invalidRange: 'Invalid range',
  startDate: 'Start date',
};
const germanDateFormatter = new Intl.DateTimeFormat('de-DE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const triggerName = `${germanDateFormatter.format(new Date(2026, 2, 4))} - ${germanDateFormatter.format(new Date(2026, 2, 9))}`;

function renderPicker(onSelectDateRange = jest.fn()) {
  render(
    <LocalizedDateRangePicker
      endDate={new Date(2026, 2, 9, 17)}
      futureDatesDisabled={false}
      labels={labels}
      locale="de-DE"
      maxRangeLength={10}
      onSelectDateRange={onSelectDateRange}
      placeholder="Select dates"
      startDate={new Date(2026, 2, 4, 9)}
    />,
  );
}

describe('LocalizedDateRangePicker', () => {
  it('formats the range with the active locale and exposes localized labels', () => {
    renderPicker();

    fireEvent.click(screen.getByRole('button', { name: triggerName }));

    expect(screen.getByLabelText(labels.startDate)).toHaveAttribute('lang', 'de-DE');
    expect(screen.getByLabelText(labels.endDate)).toHaveAttribute('lang', 'de-DE');
    expect(screen.getByRole('button', { name: labels.apply })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: labels.cancel })).toBeInTheDocument();
  });

  it('validates the range and returns complete local calendar days', () => {
    const onSelectDateRange = jest.fn();
    renderPicker(onSelectDateRange);
    fireEvent.click(screen.getByRole('button', { name: triggerName }));

    fireEvent.change(screen.getByLabelText(labels.endDate), { target: { value: '2026-03-14' } });
    expect(screen.getByText(labels.invalidRange)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: labels.apply })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(labels.endDate), { target: { value: '2026-03-10' } });
    fireEvent.click(screen.getByRole('button', { name: labels.apply }));

    const [startDate, endDate] = onSelectDateRange.mock.calls[0] as [Date, Date];
    expect([startDate.getFullYear(), startDate.getMonth(), startDate.getDate()]).toEqual([
      2026, 2, 4,
    ]);
    expect([startDate.getHours(), startDate.getMinutes()]).toEqual([0, 0]);
    expect([endDate.getFullYear(), endDate.getMonth(), endDate.getDate()]).toEqual([2026, 2, 10]);
    expect([endDate.getHours(), endDate.getMinutes(), endDate.getSeconds()]).toEqual([23, 59, 59]);
  });

  it('does not convert an unchanged rolling shortcut to a custom range', () => {
    const onSelectDateRange = jest.fn();
    const startDate = new Date(2026, 7, 1, 15, 30);
    const endDate = new Date(2026, 7, 31, 15, 30);
    const rangeName = `${germanDateFormatter.format(startDate)} - ${germanDateFormatter.format(endDate)}`;
    render(
      <LocalizedDateRangePicker
        endDate={endDate}
        futureDatesDisabled={false}
        labels={labels}
        locale="de-DE"
        maxRangeLength={30}
        onSelectDateRange={onSelectDateRange}
        placeholder="Select dates"
        startDate={startDate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: rangeName }));
    fireEvent.click(screen.getByRole('button', { name: labels.apply }));

    expect(onSelectDateRange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: labels.apply })).not.toBeInTheDocument();
  });
});
