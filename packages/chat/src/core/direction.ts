/**
 * Ranges generated from Bidi_Class in the Unicode 17.0 UnicodeData.txt, matching the Unicode
 * version of current browsers and runtimes: R and AL, every class other than L, R and AL, and
 * the few nonspacing marks whose class is L. Unassigned code points, surrogates, controls and
 * (outside the last table) nonspacing and enclosing marks are left out, so a range spans the
 * gaps between its members. To regenerate, read field 3 (category) and field 5 (bidi class)
 * of each code point, expanding the First/Last pairs, apply those exclusions and merge the
 * code points of each table into ranges.
 */
const RTL_STRONG =
  /[\u05BE-\u05F4\u0608\u060B\u060D\u061B-\u064A\u066D-\u06D5\u06E5-\u06E6\u06EE-\u06EF\u06FA-\u07F5\u07FA-\u088F\u08A0-\u08C9\u200F\uFB1D-\uFB28\uFB2A-\uFBC2\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFC\uFE70-\uFEFC\u{10800}-\u{1091B}\u{10920}-\u{10B35}\u{10B40}-\u{10D23}\u{10D4A}-\u{10D65}\u{10D6F}-\u{10D8F}\u{10E80}-\u{10EC7}\u{10F00}-\u{10FF6}\u{1E800}-\u{1EEBB}]/u;
const NOT_STRONG =
  /[\u0020-\u0040\u005B-\u0060\u007B-\u00A9\u00AB-\u00B4\u00B6-\u00B9\u00BB-\u00BF\u00D7\u00F7\u02B9-\u02BA\u02C2-\u02CF\u02D2-\u02DF\u02E5-\u02ED\u02EF-\u02FF\u0374-\u0375\u037E\u0384-\u0385\u0387\u03F6\u058A-\u08E2\u09F2-\u09F3\u09FB\u0AF1\u0BF3-\u0BFA\u0C78-\u0C7E\u0E3F\u0F3A-\u0F3D\u1390-\u1399\u1400\u1680\u169B-\u169C\u17DB\u17F0-\u180E\u1940-\u1945\u19DE-\u19FF\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD-\u200D\u2010-\u2070\u2074-\u207E\u2080-\u208E\u20A0-\u2101\u2103-\u2106\u2108-\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A-\u213B\u2140-\u2144\u214A-\u214D\u2150-\u215F\u2189-\u2335\u237B-\u2394\u2396-\u249B\u24EA-\u26AB\u26AD-\u27FF\u2900-\u2BFF\u2CE5-\u2CEA\u2CF9-\u2CFF\u2E00-\u3004\u3008-\u3020\u3030\u3036-\u3037\u303D-\u303F\u309B-\u309C\u30A0\u30FB\u31C0-\u31EF\u321D-\u321E\u3250-\u325F\u327C-\u327E\u32B1-\u32BF\u32CC-\u32CF\u3377-\u337A\u33DE-\u33DF\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA60D-\uA60F\uA673-\uA67F\uA700-\uA721\uA788\uA828-\uA82B\uA838-\uA839\uA874-\uA877\uAB6A-\uAB6B\uFB29-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\uFFE0-\uFFFD\u{10101}\u{10140}-\u{1018C}\u{10190}-\u{101A0}\u{102E1}-\u{102FB}\u{1091F}-\u{10ED8}\u{11052}-\u{11065}\u{11660}-\u{1166C}\u{11FD5}-\u{11FF1}\u{16FE2}\u{1BCA0}-\u{1CCD5}\u{1CCF0}-\u{1CEF0}\u{1D173}-\u{1D17A}\u{1D1E9}-\u{1D245}\u{1D300}-\u{1D356}\u{1D6C1}\u{1D6DB}\u{1D6FB}\u{1D715}\u{1D735}\u{1D74F}\u{1D76F}\u{1D789}\u{1D7A9}\u{1D7C3}\u{1D7CE}-\u{1D7FF}\u{1E2FF}\u{1EEF0}-\u{1F10F}\u{1F12F}\u{1F16A}-\u{1F16F}\u{1F1AD}\u{1F260}-\u{1FBFA}\u{E0001}-\u{E007F}]/u;
const LTR_MARK = /[\u0CBF-\u0CC6\u{11A07}-\u{11A08}\u{11C3F}]/u;
/** Nonspacing and enclosing marks (NSM) and controls (BN, B, S, WS) are never strong. */
const SKIP = /[\p{Mn}\p{Me}\p{Cc}]/u;

/**
 * Direction of the first strongly directional character, or null when the text has none,
 * as the browser's `dir="auto"` resolves it: a character of bidi class R or AL is
 * right-to-left, L is left-to-right, and digits, punctuation, symbols and marks are skipped.
 */
export const strongDirection = (text: string): 'ltr' | 'rtl' | null => {
  for (const char of text) {
    if (LTR_MARK.test(char)) {
      return 'ltr';
    }
    if (SKIP.test(char)) {
      continue;
    }
    if (RTL_STRONG.test(char)) {
      return 'rtl';
    }
    if (!NOT_STRONG.test(char)) {
      return 'ltr';
    }
  }
  return null;
};
