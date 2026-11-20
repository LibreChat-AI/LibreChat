import type { ReactElement, ReactNode } from 'react';
import type { RailHover } from '../rail';
import PhaseLabel from '../PhaseLabel';
import { RailGlyph } from '../rail';

export type LivePhaseHeaderProps = {
  text: string;
  source: string;
  animate: boolean;
  lineId: string;
  comboId: string;
  detailId: string;
  combo: string;
  isBackgroundTaskCheck?: boolean;
  failedNote: string;
  cancelledNote: string;
  railHover: RailHover;
  glyph: ReactNode;
};

/** The painted live line; its host resolves activity, icons, counts and announcements. */
export default function LivePhaseHeader({
  text,
  source,
  animate,
  lineId,
  comboId,
  detailId,
  combo,
  isBackgroundTaskCheck,
  failedNote,
  cancelledNote,
  railHover,
  glyph,
}: LivePhaseHeaderProps): ReactElement {
  return (
    <>
      <RailGlyph hover={railHover}>{glyph}</RailGlyph>
      {/** The multiplier counts the line it is printed next to, so it travels
       *  with that line instead of sitting out at the row's right edge beside
       *  the chevron, where it read as a property of the row. `Create File ×2`
       *  in the unfolded group is the same phrase in the same order. It is a
       *  separate element rather than part of the line's text so the
       *  disclosure's name keeps a space before it and the ticker still
       *  animates one sentence at a time. */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <PhaseLabel
          text={text}
          source={source}
          animate={animate}
          live
          grow={combo === ''}
          lineId={lineId}
        />
        {combo !== '' && (
          <span
            id={comboId}
            className={
              isBackgroundTaskCheck ? 'text-text-secondary shrink-0 text-xs font-normal' : 'sr-only'
            }
            data-testid="live-phase-combo"
          >
            {combo}
          </span>
        )}
      </span>
      {(failedNote !== '' || cancelledNote !== '') && (
        <span
          id={detailId}
          className="text-text-warning shrink-0 text-xs font-normal"
          data-testid="live-phase-outcome"
        >
          {/** The failure count is spoken here, as part of the header's name,
           *  and SHOWN by the pill beside the header, which is also the way to
           *  the failed rows. Only a stop count has no pill and stays visible.
           *  The verdict is the span's, not the newest line's, so it keeps its
           *  own separator from whatever the row happens to be saying. */}
          {failedNote !== '' && <span className="sr-only">· {failedNote}</span>}
          {cancelledNote !== '' && (
            <>
              <span className="text-text-secondary me-1">·</span>
              <span>{cancelledNote}</span>
            </>
          )}
        </span>
      )}
    </>
  );
}
