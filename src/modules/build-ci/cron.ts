export interface CronField {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
}

export interface ParsedCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

function parseField(source: string, min: number, max: number, normalize?: (value: number) => number): CronField {
  const values = new Set<number>();
  const wildcard = source === '*' || source.startsWith('*/');
  for (const part of source.split(',')) {
    const segments = part.split('/');
    if (segments.length > 2) throw new TypeError('Invalid cron field');
    const [base, stepText] = segments;
    if (!base || (stepText !== undefined && (!/^\\d+$/.test(stepText) || Number(stepText) < 1 || Number(stepText) > max - min + 1))) throw new TypeError('Invalid cron step');
    const step = stepText === undefined ? 1 : Number(stepText);
    const bounds = base === '*' ? [min, max] : base.includes('-') ? base.split('-').map(Number) : [Number(base), stepText === undefined ? Number(base) : max];
    if (bounds.length !== 2 || bounds.some((value) => !Number.isInteger(value) || value < min || value > max) || bounds[0]! > bounds[1]!) throw new TypeError('Invalid cron field');
    const start = bounds[0]!;
    const end = bounds[1]!;
    for (let value = start; value <= end; value += step) values.add(normalize ? normalize(value) : value);
  }
  return Object.freeze({ values, wildcard });
}

export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new TypeError('Cron must contain exactly five fields');
  return Object.freeze({
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dayOfMonth: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12),
    dayOfWeek: parseField(fields[4]!, 0, 7, (value) => value === 7 ? 0 : value),
  });
}

const weekdayNumber: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
});

function matchesFormattedInstant(cron: ParsedCron, parts: Intl.DateTimeFormatPart[]): boolean {
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? '';
  const minute = Number(part('minute'));
  const hour = Number(part('hour'));
  const day = Number(part('day'));
  const month = Number(part('month'));
  const weekday = weekdayNumber[part('weekday')];
  if (weekday === undefined || !cron.minute.values.has(minute) || !cron.hour.values.has(hour) || !cron.month.values.has(month)) return false;
  const dayMatches = cron.dayOfMonth.values.has(day);
  const weekdayMatches = cron.dayOfWeek.values.has(weekday);
  const calendarDayMatches = cron.dayOfMonth.wildcard ? weekdayMatches
    : cron.dayOfWeek.wildcard ? dayMatches
    : dayMatches || weekdayMatches;
  return calendarDayMatches;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit',
    weekday: 'short', hourCycle: 'h23',
  });
}

export function cronMatchesInstant(cron: ParsedCron, timestamp: number, timeZone: string): boolean {
  if (!Number.isFinite(timestamp) || timestamp % 60_000 !== 0) throw new TypeError('timestamp must be aligned to a UTC minute');
  return matchesFormattedInstant(cron, formatterFor(timeZone).formatToParts(timestamp));
}

/**
 * Enumerates UTC instants in an inclusive, minute-aligned range. Formatting each
 * instant in the requested IANA zone naturally skips nonexistent spring-forward
 * wall times and returns both UTC instants for repeated fall-back wall times.
 */
export function findCronOccurrences(
  expression: string,
  timeZone: string,
  fromInclusive: number,
  toInclusive: number,
  maxMinutes = 10_080,
): readonly number[] {
  if (!Number.isSafeInteger(fromInclusive) || !Number.isSafeInteger(toInclusive) ||
      fromInclusive % 60_000 !== 0 || toInclusive % 60_000 !== 0 || toInclusive < fromInclusive) {
    throw new TypeError('Cron range must be ordered, UTC minute-aligned timestamps');
  }
  const minutes = Math.floor((toInclusive - fromInclusive) / 60_000) + 1;
  if (minutes > maxMinutes || maxMinutes < 1 || maxMinutes > 10_080) throw new RangeError('Cron scan range exceeds the configured 7-day bound');
  const cron = parseCronExpression(expression);
  // Reuse one timezone formatter for the entire bounded scan.
  const formatter = formatterFor(timeZone);
  formatter.format(fromInclusive);
  const found: number[] = [];
  for (let timestamp = fromInclusive; timestamp <= toInclusive; timestamp += 60_000) {
    if (matchesFormattedInstant(cron, formatter.formatToParts(timestamp))) found.push(timestamp);
  }
  return Object.freeze(found);
}
