import { useMediaQuery, useRemScale } from '@librechat/client';
import { scaledMaxWidthQuery } from '~/utils/breakpoints';

/**
 * Whether the viewport is at most `baselinePx` wide, measured in the units the layout is
 * expressed in. Use this rather than a fixed pixel query wherever the branch chooses
 * between a wide and a narrow layout: at a larger scale the wide one keeps being picked
 * while its rem-sized contents outgrow the space it gives them.
 */
export default function useScaledMaxWidth(baselinePx: number): boolean {
  const remScale = useRemScale();
  return useMediaQuery(scaledMaxWidthQuery(baselinePx, remScale));
}
