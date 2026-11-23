/**
 * Deploy window such as "Tue,Thu 18:00-21:00 Europe/Warsaw" or "Mon-Fri 22:00-02:00 UTC".
 * Days name the day the window opens; an end time earlier than the start runs past midnight.
 */
export interface DeployWindow {
  days: Set<number>;
  startMinutes: number;
  endMinutes: number;
  timeZone: string;
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FORMAT_HINT = 'oczekiwano np. "Tue,Thu 18:00-21:00 Europe/Warsaw"';

export type ParseResult = { ok: true; window: DeployWindow } | { ok: false; message: string };

function parseTime(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

function parseDays(value: string): Set<number> | undefined {
  const days = new Set<number>();
  for (const part of value.toLowerCase().split(',')) {
    const [from, to] = part.split('-');
    const start = DAY_NAMES.indexOf(from ?? '');
    const end = to === undefined ? start : DAY_NAMES.indexOf(to);
    if (start < 0 || end < 0) return undefined;
    for (let day = start; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === end) break;
    }
  }
  return days;
}

export function parseDeployWindow(value: string): ParseResult {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3) return { ok: false, message: `Nieprawidłowe okno serwisowe: ${FORMAT_HINT}` };
  const [daysPart, timesPart, timeZone] = parts as [string, string, string];

  const days = parseDays(daysPart);
  if (!days) return { ok: false, message: `Nieznane dni "${daysPart}": użyj Mon,Tue,Wed,Thu,Fri,Sat,Sun lub zakresu Mon-Fri` };

  const [startText, endText] = timesPart.split('-');
  const startMinutes = parseTime(startText ?? '');
  const endMinutes = parseTime(endText ?? '');
  if (startMinutes === undefined || endMinutes === undefined || startMinutes === endMinutes) {
    return { ok: false, message: `Nieprawidłowe godziny "${timesPart}": ${FORMAT_HINT}` };
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    return { ok: false, message: `Nieznana strefa czasowa "${timeZone}", np. Europe/Warsaw` };
  }
  return { ok: true, window: { days, startMinutes, endMinutes, timeZone } };
}

function localTime(date: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: DAY_NAMES.indexOf(get('weekday').toLowerCase()),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export function isWithinWindow(window: DeployWindow, date: Date): boolean {
  const { day, minutes } = localTime(date, window.timeZone);
  if (window.startMinutes < window.endMinutes) {
    return window.days.has(day) && minutes >= window.startMinutes && minutes < window.endMinutes;
  }
  // Overnight window: the evening part belongs to today, the early-morning part to yesterday.
  if (minutes >= window.startMinutes) return window.days.has(day);
  if (minutes < window.endMinutes) return window.days.has((day + 6) % 7);
  return false;
}
