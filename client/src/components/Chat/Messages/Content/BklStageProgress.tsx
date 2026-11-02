import { memo, useCallback, useEffect, useMemo, useRef, useState, useId } from 'react';
import { useAtomValue } from 'jotai';
import { ChevronDown } from 'lucide-react';
import type { MouseEvent } from 'react';
import { showThinkingAtom } from '~/store/showThinking';
import { cn } from '~/utils';

/**
 * BKL 진행 단계 표시 (2026-11-02).
 *
 * bkl-api 가 답변 첫 토큰 전에 `delta.reasoning_content` 로 흘려보내는
 * "라벨 — 상세" 한 줄짜리 진행 단계를 "생각" 블록 대신 단계 목록으로 그린다.
 *
 * - 스트리밍 중(본문 전): 기본 펼침, 헤더에 현재 단계명과 진행 표시.
 * - 본문이 시작되면 자동으로 접힘(사용자가 직접 토글했으면 그대로 둠).
 * - 끝난 뒤: "진행 내역" 으로 접혀 있고 눌러서 다시 볼 수 있다.
 *
 * 디자인: 무색 배경에 얇은 테두리 상자 하나, 줄마다 문장 하나(라벨 열 없음).
 * 본문보다 한 단계 작은 글자(text-sm)와 흐린 색으로 본문과 구별.
 * 아이콘은 진행 중 점 세 개 깜빡임 하나뿐.
 *
 * 판별은 백엔드 `src/api/utils/stage_progress.py` 가 쓰는 라벨 집합으로 한다.
 * 일반 reasoning 모델의 사고 과정은 여기 걸리지 않고 기존 Reasoning 으로 간다.
 */
export const BKL_STAGE_LABELS = new Set([
  '질문 분석',
  '문서 검색',
  '범위 확인',
  '결과 검토',
  '검색 전략 수정',
  '재검색',
  '검색 결과',
  '근거 정리',
  '문서 전문 확인',
  '답변 작성',
]);

const SEPARATOR = ' — ';

export type BklStage = { label: string; detail: string };

/** 첫 줄이 알려진 라벨로 시작할 때만 단계 목록을 돌려준다. 아니면 null. */
export function parseBklStages(text: string | null | undefined): BklStage[] | null {
  if (!text) {
    return null;
  }
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const firstLabel = lines[0].split(SEPARATOR)[0].trim();
  if (!BKL_STAGE_LABELS.has(firstLabel)) {
    return null;
  }
  return lines.map((line) => {
    const idx = line.indexOf(SEPARATOR);
    if (idx < 0) {
      return { label: line, detail: '' };
    }
    return { label: line.slice(0, idx).trim(), detail: line.slice(idx + SEPARATOR.length).trim() };
  });
}

/** 헤더용 진행형 라벨 ("재검색" → "재검색 중") */
const PROGRESSIVE: Record<string, string> = {
  '검색 결과': '검색 결과 확인 중',
  '범위 확인': '검색 범위 확인 중',
};
export const progressiveLabel = (label: string): string => PROGRESSIVE[label] ?? `${label} 중`;

/** 진행 중 표시: 점 세 개가 순서대로 깜빡인다 */
const PulseDots = () => (
  <span className="inline-flex items-center gap-[3px]" aria-hidden="true">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className="h-[5px] w-[5px] animate-pulse rounded-full bg-text-secondary"
        style={{ animationDelay: `${i * 220}ms` }}
      />
    ))}
  </span>
);

type Props = {
  stages: BklStage[];
  /** 최신 메시지가 아직 생성 중인가 */
  isStreaming: boolean;
  /** 이 THINK 파트가 메시지의 마지막 파트인가 (false 면 본문이 시작된 것) */
  isLast: boolean;
};

const BklStageProgress = memo(({ stages, isStreaming, isLast }: Props) => {
  const contentId = useId();
  const showThinking = useAtomValue(showThinkingAtom);

  // 본문 전 스트리밍 = "진행 중". 본문이 시작되거나 생성이 끝나면 "완료".
  const inProgress = isStreaming && isLast;

  const [isExpanded, setIsExpanded] = useState<boolean>(inProgress || showThinking);
  const userToggled = useRef(false);
  const wasInProgress = useRef(inProgress);

  useEffect(() => {
    if (userToggled.current) {
      wasInProgress.current = inProgress;
      return;
    }
    if (inProgress) {
      // 진행 중이면 펼쳐서 보여준다 (첫 렌더 시점엔 isSubmitting 이 아직 false 일 수 있음)
      setIsExpanded(true);
    } else if (wasInProgress.current) {
      // 진행 중 → 완료(본문 시작)로 넘어가는 순간 접는다
      setIsExpanded(showThinking);
    }
    wasInProgress.current = inProgress;
  }, [inProgress, showThinking]);

  const handleClick = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    userToggled.current = true;
    setIsExpanded((prev) => !prev);
  }, []);

  const current = stages[stages.length - 1];
  const headerLabel = useMemo(() => {
    if (inProgress) {
      return current ? progressiveLabel(current.label) : '검색 진행 중';
    }
    return '진행 내역';
  }, [inProgress, current]);

  if (stages.length === 0) {
    return null;
  }

  return (
    <div className="group/bkl-stage" data-testid="bkl-stage-progress">
      <div className="pb-2 pt-1">
        <button
          type="button"
          onClick={handleClick}
          aria-expanded={isExpanded}
          aria-controls={contentId}
          className="group/button inline-flex items-center gap-2 rounded-md text-sm leading-[18px] text-text-secondary hover:text-text-primary"
        >
          {inProgress && <PulseDots />}
          <span>{headerLabel}</span>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 transform-gpu transition-transform duration-200',
              isExpanded && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
      </div>
      <div
        id={contentId}
        role="group"
        aria-label={headerLabel}
        aria-hidden={!isExpanded || undefined}
        className={cn('grid transition-all duration-300 ease-out', isExpanded && 'mb-4')}
        style={{ gridTemplateRows: isExpanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <ol className="rounded-xl border border-border-light px-4 py-2.5 text-sm">
            {stages.map((s, i) => {
              const isCurrent = inProgress && i === stages.length - 1;
              return (
                <li
                  key={`${i}-${s.label}`}
                  className={cn(
                    'truncate py-1 leading-[20px]',
                    isCurrent ? 'text-text-secondary' : 'text-text-tertiary',
                  )}
                  data-testid="bkl-stage-row"
                  data-state={isCurrent ? 'running' : 'done'}
                  title={s.detail || s.label}
                >
                  {/* 라벨은 헤더/판별용. 줄에는 혼자 읽히는 문장만 보여준다 */}
                  {s.detail || s.label}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
});

BklStageProgress.displayName = 'BklStageProgress';

export default BklStageProgress;
