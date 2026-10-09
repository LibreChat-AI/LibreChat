import {
  resolveHour12,
  localeUsesMeridiem,
  resolveWeekStartsOn,
  localeWeekStartsOn,
  rotateWeekFrom,
} from '../clock';

describe('resolveHour12', () => {
  it('forces true for the 12h preference regardless of locale', () => {
    expect(resolveHour12('12h', 'de-DE')).toBe(true);
  });

  it('forces false for the 24h preference regardless of locale', () => {
    expect(resolveHour12('24h', 'en-US')).toBe(false);
  });

  it('defers to the locale for the system preference', () => {
    expect(resolveHour12('system', 'en-US')).toBe(true);
    expect(resolveHour12('system', 'de-DE')).toBe(false);
  });
});

describe('localeUsesMeridiem', () => {
  it('does not throw on a garbage locale tag, and returns a boolean', () => {
    expect(typeof localeUsesMeridiem('not-a-real-locale')).toBe('boolean');
  });
});

describe('resolveWeekStartsOn', () => {
  it('forces Sunday (0) for the sunday preference regardless of locale', () => {
    expect(resolveWeekStartsOn('sunday', 'fr-FR')).toBe(0);
  });

  it('forces Monday (1) for the monday preference regardless of locale', () => {
    expect(resolveWeekStartsOn('monday', 'en-US')).toBe(1);
  });

  it('defers to the locale for the system preference', () => {
    // en-US: Sunday-first; fr-FR/de-DE/en-GB: Monday-first (CLDR week data)
    expect(resolveWeekStartsOn('system', 'en-US')).toBe(0);
    expect(resolveWeekStartsOn('system', 'fr-FR')).toBe(1);
    expect(resolveWeekStartsOn('system', 'de-DE')).toBe(1);
  });
});

describe('localeWeekStartsOn', () => {
  it('does not throw on a garbage locale tag, and returns a day index', () => {
    expect([0, 1, 2, 3, 4, 5, 6]).toContain(localeWeekStartsOn('not-a-real-locale'));
  });

  it('reports Saturday for locales whose week starts there, not a folded 0 or 1', () => {
    // Only meaningful where the engine ships week data; without it the region
    // heuristic below answers instead.
    const resolved = new Intl.Locale('ar-EG') as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const weekInfo =
      typeof resolved.getWeekInfo === 'function' ? resolved.getWeekInfo() : resolved.weekInfo;
    if (weekInfo?.firstDay !== 6) {
      return;
    }
    expect(localeWeekStartsOn('ar-EG')).toBe(6);
  });

  /** Deletes the engine's week data for the duration, so the region heuristic
   *  is what answers, on every engine rather than only pre-Baseline-2024 ones. */
  const withoutEngineWeekData = (run: () => void) => {
    const proto = Intl.Locale.prototype as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const getWeekInfo = Object.getOwnPropertyDescriptor(proto, 'getWeekInfo');
    const weekInfo = Object.getOwnPropertyDescriptor(proto, 'weekInfo');
    if (getWeekInfo != null) {
      delete proto.getWeekInfo;
    }
    if (weekInfo != null) {
      delete proto.weekInfo;
    }
    try {
      run();
    } finally {
      if (getWeekInfo != null) {
        Object.defineProperty(proto, 'getWeekInfo', getWeekInfo);
      }
      if (weekInfo != null) {
        Object.defineProperty(proto, 'weekInfo', weekInfo);
      }
    }
  };

  it('keeps Saturday-first regions on Saturday in the no-week-data fallback', () => {
    withoutEngineWeekData(() => {
      // CLDR: Egypt and Iran start the week on Saturday; folding them to Sunday
      // or Monday left those users no route back, the selector having no
      // explicit Saturday option.
      expect(localeWeekStartsOn('ar-EG')).toBe(6);
      expect(localeWeekStartsOn('fa-IR')).toBe(6);
    });
  });

  it('keeps the Maldives on Friday in the same fallback', () => {
    withoutEngineWeekData(() => {
      // CLDR's lone Friday-first territory, reachable as dv-MV or bare dv.
      expect(localeWeekStartsOn('dv-MV')).toBe(5);
      expect(localeWeekStartsOn('dv')).toBe(5);
    });
  });

  it('keeps Sunday-first and Monday-first regions apart in the same fallback', () => {
    withoutEngineWeekData(() => {
      expect(localeWeekStartsOn('en-US')).toBe(0);
      expect(localeWeekStartsOn('he-IL')).toBe(0);
      // From the long tail the original hand-picked list missed.
      expect(localeWeekStartsOn('en-IN')).toBe(0);
      expect(localeWeekStartsOn('th-TH')).toBe(0);
      expect(localeWeekStartsOn('fr-FR')).toBe(1);
      // CLDR moved the UAE to Monday when its weekend moved to Sat-Sun.
      expect(localeWeekStartsOn('ar-AE')).toBe(1);
    });
  });

  it('infers the likely region for a language-only tag instead of defaulting', () => {
    // A runtime can report a bare language ('ar', 'en'); maximize() supplies the
    // likely region, so those users are not all folded onto Monday.
    withoutEngineWeekData(() => {
      expect(localeWeekStartsOn('ar')).toBe(6);
      expect(localeWeekStartsOn('fa')).toBe(6);
      expect(localeWeekStartsOn('en')).toBe(0);
      expect(localeWeekStartsOn('fr')).toBe(1);
    });
  });
});

describe('rotateWeekFrom', () => {
  it('is a no-op rotation for Sunday-first (identity)', () => {
    expect(rotateWeekFrom(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('rotates to start at Monday, wrapping Sunday to the end', () => {
    expect(rotateWeekFrom(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it('rotates to start at Saturday, wrapping Sunday through Friday to the end', () => {
    expect(rotateWeekFrom(6)).toEqual([6, 0, 1, 2, 3, 4, 5]);
  });
});
