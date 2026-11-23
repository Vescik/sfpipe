import { describe, expect, it } from 'vitest';
import { isWithinWindow, parseDeployWindow, type DeployWindow } from '../src/core/deploy-window.js';

function windowOf(text: string): DeployWindow {
  const result = parseDeployWindow(text);
  if (!result.ok) throw new Error(result.message);
  return result.window;
}

describe('parseDeployWindow', () => {
  it('parses day lists, ranges and wrap-around ranges', () => {
    expect([...windowOf('Tue,Thu 18:00-21:00 Europe/Warsaw').days]).toEqual([2, 4]);
    expect([...windowOf('Mon-Fri 08:00-16:00 UTC').days].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...windowOf('Fri-Mon 22:00-02:00 UTC').days].sort()).toEqual([0, 1, 5, 6]);
  });

  it('rejects malformed windows with a specific message', () => {
    expect(parseDeployWindow('Tue 18:00-21:00')).toMatchObject({ ok: false, message: expect.stringMatching(/okno serwisowe/) });
    expect(parseDeployWindow('Tus 18:00-21:00 UTC')).toMatchObject({ ok: false, message: expect.stringMatching(/Nieznane dni/) });
    expect(parseDeployWindow('Tue 18:00-18:00 UTC')).toMatchObject({ ok: false, message: expect.stringMatching(/godziny/) });
    expect(parseDeployWindow('Tue 18:00-21:00 Mars/Base')).toMatchObject({ ok: false, message: expect.stringMatching(/strefa/) });
  });
});

describe('isWithinWindow', () => {
  // 2026-11-24 is a Tuesday. Warsaw is UTC+1 in November.
  const warsaw = windowOf('Tue,Thu 18:00-21:00 Europe/Warsaw');

  it('uses the configured time zone', () => {
    expect(isWithinWindow(warsaw, new Date('2026-11-24T17:30:00Z'))).toBe(true); // 18:30 Warsaw
    expect(isWithinWindow(warsaw, new Date('2026-11-24T16:59:00Z'))).toBe(false); // 17:59 Warsaw
    expect(isWithinWindow(warsaw, new Date('2026-11-24T20:00:00Z'))).toBe(false); // 21:00 Warsaw, end exclusive
    expect(isWithinWindow(warsaw, new Date('2026-11-25T17:30:00Z'))).toBe(false); // Wednesday
  });

  it('counts the early-morning part of an overnight window to the previous day', () => {
    const overnight = windowOf('Fri 22:00-02:00 UTC');
    expect(isWithinWindow(overnight, new Date('2026-11-27T23:00:00Z'))).toBe(true); // Friday 23:00
    expect(isWithinWindow(overnight, new Date('2026-11-28T01:30:00Z'))).toBe(true); // Saturday 01:30
    expect(isWithinWindow(overnight, new Date('2026-11-28T23:00:00Z'))).toBe(false); // Saturday 23:00
    expect(isWithinWindow(overnight, new Date('2026-11-27T01:30:00Z'))).toBe(false); // Friday 01:30 (Thursday night)
  });
});
