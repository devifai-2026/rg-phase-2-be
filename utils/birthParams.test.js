const { birthParams, hasBirthData, splitDate, normalizeTime } = require('./birthParams');

describe('birthParams', () => {
  describe('date formats — both must be produced', () => {
    it('emits ISO and DMY from a Date', () => {
      const p = birthParams({ dob: new Date('1995-08-15T00:00:00Z') });
      expect(p.dob).toBe('1995-08-15');
      expect(p.dobDmy).toBe('15/08/1995');
    });

    it('emits both from an ISO string', () => {
      const p = birthParams({ dob: '1995-08-15' });
      expect(p.dob).toBe('1995-08-15');
      expect(p.dobDmy).toBe('15/08/1995');
    });

    it('accepts DD/MM/YYYY input and derives the ISO form', () => {
      const p = birthParams({ dob: '15/08/1995' });
      expect(p.dob).toBe('1995-08-15');
      expect(p.dobDmy).toBe('15/08/1995');
    });

    // Mongo stores a DOB at UTC midnight. Local getters would report the
    // previous day for anyone west of Greenwich, shifting every chart by a day.
    it('uses UTC calendar parts, not local', () => {
      const p = birthParams({ dob: new Date('2000-01-01T00:00:00Z') });
      expect(p.dob).toBe('2000-01-01');
      expect(p.dobDmy).toBe('01/01/2000');
    });

    it('returns nulls for an unparseable date rather than throwing', () => {
      const p = birthParams({ dob: 'not a date' });
      expect(p.dob).toBeNull();
      expect(p.dobDmy).toBeNull();
    });
  });

  // The single most dangerous rename: dropping it silently computes the chart at
  // longitude 0, which looks plausible and is wrong.
  describe('lng -> lon', () => {
    it('maps the stored `lng` field onto `lon`', () => {
      const p = birthParams({ dob: '1995-08-15', lat: 22.57, lng: 88.36 });
      expect(p.lon).toBe(88.36);
    });

    it('accepts `lon` directly (request-body shape)', () => {
      const p = birthParams({ dob: '1995-08-15', lat: 22.57, lon: 88.36 });
      expect(p.lon).toBe(88.36);
    });

    it('prefers an explicit `lon` over `lng`', () => {
      const p = birthParams({ lat: 1, lon: 10, lng: 20 });
      expect(p.lon).toBe(10);
    });

    it('coerces numeric strings', () => {
      const p = birthParams({ lat: '22.57', lng: '88.36' });
      expect(p.lat).toBe(22.57);
      expect(p.lon).toBe(88.36);
    });

    it('nulls a non-numeric coordinate instead of emitting NaN', () => {
      const p = birthParams({ lat: 'abc', lng: null });
      expect(p.lat).toBeNull();
      expect(p.lon).toBeNull();
    });

    // 0 is a legitimate coordinate and must survive a falsy check.
    it('keeps a zero coordinate', () => {
      const p = birthParams({ lat: 0, lng: 0 });
      expect(p.lat).toBe(0);
      expect(p.lon).toBe(0);
    });
  });

  describe('time of birth', () => {
    it('reads the stored `time` field', () => {
      expect(birthParams({ time: '14:30' }).tob).toBe('14:30');
    });

    it('reads a request-shaped `tob`', () => {
      expect(birthParams({ tob: '14:30' }).tob).toBe('14:30');
    });

    it('zero-pads a single-digit hour', () => {
      expect(birthParams({ time: '9:05' }).tob).toBe('09:05');
    });

    it('drops seconds', () => {
      expect(birthParams({ time: '14:30:59' }).tob).toBe('14:30');
    });

    // timeKnown:false is the seeker saying they don't know. Noon is the
    // conventional stand-in; the flag is surfaced so the prompt can disclaim the
    // ascendant rather than assert one it cannot support.
    it('falls back to noon when the time is unknown, and reports timeKnown', () => {
      const p = birthParams({ dob: '1995-08-15', timeKnown: false });
      expect(p.tob).toBe('12:00');
      expect(p.timeKnown).toBe(false);
    });

    it('defaults timeKnown to true when absent', () => {
      expect(birthParams({ time: '10:00' }).timeKnown).toBe(true);
    });

    it('falls back to noon when the time is missing entirely', () => {
      expect(birthParams({ dob: '1995-08-15' }).tob).toBe('12:00');
    });
  });

  describe('timezone', () => {
    it('defaults to IST', () => {
      expect(birthParams({}).tz).toBe(5.5);
    });

    it('honours an explicit tz', () => {
      expect(birthParams({ tz: 1 }).tz).toBe(1);
    });

    it('ignores a non-numeric tz', () => {
      expect(birthParams({ tz: 'abc' }).tz).toBe(5.5);
    });

    it('keeps tz 0 (UTC) rather than defaulting it away', () => {
      expect(birthParams({ tz: 0 }).tz).toBe(0);
    });
  });

  it('never throws on empty or missing input', () => {
    expect(() => birthParams()).not.toThrow();
    expect(() => birthParams(null)).not.toThrow();
    expect(birthParams().dob).toBeNull();
  });
});

describe('hasBirthData', () => {
  it('requires a date and both coordinates', () => {
    expect(hasBirthData(birthParams({ dob: '1995-08-15', lat: 22.5, lng: 88.3 }))).toBe(true);
  });

  it('is false without a date', () => {
    expect(hasBirthData(birthParams({ lat: 22.5, lng: 88.3 }))).toBe(false);
  });

  it('is false without coordinates', () => {
    expect(hasBirthData(birthParams({ dob: '1995-08-15' }))).toBe(false);
  });

  it('is true at 0,0 — a valid coordinate, not missing data', () => {
    expect(hasBirthData(birthParams({ dob: '1995-08-15', lat: 0, lng: 0 }))).toBe(true);
  });

  it('is false for null/undefined', () => {
    expect(hasBirthData(null)).toBe(false);
    expect(hasBirthData(undefined)).toBe(false);
  });
});

describe('splitDate / normalizeTime', () => {
  it('splitDate handles null', () => {
    expect(splitDate(null)).toEqual({ iso: null, dmy: null });
  });

  it('normalizeTime returns null for junk', () => {
    expect(normalizeTime('abc')).toBeNull();
    expect(normalizeTime('')).toBeNull();
    expect(normalizeTime(null)).toBeNull();
  });

  it('normalizeTime clamps out-of-range values instead of emitting them', () => {
    expect(normalizeTime('99:99')).toBe('23:59');
  });
});
