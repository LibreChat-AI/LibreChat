import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import BklStageProgress, { parseBklStages } from '../BklStageProgress';

jest.mock('jotai', () => {
  const actual = jest.requireActual('jotai');
  return { ...actual, useAtomValue: () => false };
});

const SAMPLE =
  '질문 분석 — 사건 1건으로 범위 제한\n' +
  '문서 검색 — 사건 1건 범위에서 하이브리드 검색(벡터·키워드·요약) 실행 중\n' +
  '결과 검토 — 1회차 후보 38개의 충분성 판정 중\n';

describe('parseBklStages', () => {
  it('parses "라벨 — 상세" lines when the first label is a known stage', () => {
    const stages = parseBklStages(SAMPLE);
    expect(stages).toEqual([
      { label: '질문 분석', detail: '사건 1건으로 범위 제한' },
      { label: '문서 검색', detail: '사건 1건 범위에서 하이브리드 검색(벡터·키워드·요약) 실행 중' },
      { label: '결과 검토', detail: '1회차 후보 38개의 충분성 판정 중' },
    ]);
  });

  it('keeps a bare label line without detail', () => {
    expect(parseBklStages('문서 검색\n')).toEqual([{ label: '문서 검색', detail: '' }]);
  });

  it('returns null for ordinary reasoning text so Reasoning keeps its default rendering', () => {
    expect(parseBklStages('The user asks about contracts. Let me think step by step.')).toBeNull();
    expect(parseBklStages('사용자가 계약 해지에 대해 묻고 있다 — 먼저 정의부터')).toBeNull();
    expect(parseBklStages('')).toBeNull();
    expect(parseBklStages(undefined)).toBeNull();
  });
});

describe('BklStageProgress', () => {
  const stages = parseBklStages(SAMPLE)!;

  it('while streaming: header shows current stage, list expanded, last row running', () => {
    render(<BklStageProgress stages={stages} isStreaming={true} isLast={true} />);
    expect(screen.getByRole('button', { name: /결과 검토 중/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const rows = screen.getAllByTestId('bkl-stage-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('data-state', 'done');
    expect(rows[2]).toHaveAttribute('data-state', 'running');
  });

  it('after the answer starts (not last part): header becomes 진행 내역 and collapses', () => {
    const { rerender } = render(
      <BklStageProgress stages={stages} isStreaming={true} isLast={true} />,
    );
    rerender(<BklStageProgress stages={stages} isStreaming={true} isLast={false} />);
    const btn = screen.getByRole('button', { name: /^진행 내역$/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    const rows = screen.getAllByTestId('bkl-stage-row');
    expect(rows.every((r) => r.getAttribute('data-state') === 'done')).toBe(true);
  });

  it('finished message: collapsed by default, toggles on click', () => {
    render(<BklStageProgress stages={stages} isStreaming={false} isLast={false} />);
    const btn = screen.getByRole('button', { name: /^진행 내역$/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('respects a manual toggle during streaming (does not auto-collapse afterwards)', () => {
    const { rerender } = render(
      <BklStageProgress stages={stages} isStreaming={true} isLast={true} />,
    );
    const btn = screen.getByRole('button');
    fireEvent.click(btn); // user collapses
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn); // user expands again
    rerender(<BklStageProgress stages={stages} isStreaming={true} isLast={false} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });
});
