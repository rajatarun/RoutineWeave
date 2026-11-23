import { ExecutionMode, TaskDefinition } from "./types";

export class InvalidCronExpressionError extends Error {
  readonly expression: string;

  constructor(expression: string, reason: string) {
    super(`Invalid cron expression "${expression}": ${reason}`);
    this.name = "InvalidCronExpressionError";
    this.expression = expression;
  }
}

interface ParsedField {
  values: Set<number>;
  isWildcard: boolean;
}

interface ParsedCron {
  minutes: ParsedField;
  hours: ParsedField;
  daysOfMonth: ParsedField;
  months: ParsedField;
  daysOfWeek: ParsedField;
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DOW_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

function parseAtomicValue(
  raw: string,
  min: number,
  max: number,
  nameMap?: Record<string, number>,
  normalizeSevenToZero = false,
): number {
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) {
    throw new Error("empty token");
  }

  let num: number;
  if (nameMap && Object.prototype.hasOwnProperty.call(nameMap, trimmed)) {
    num = nameMap[trimmed];
  } else if (/^\d+$/.test(trimmed)) {
    num = Number.parseInt(trimmed, 10);
  } else {
    throw new Error(`invalid token "${raw}"`);
  }

  if (normalizeSevenToZero && num === 7) {
    num = 0;
  }

  if (num < min || num > max) {
    throw new Error(`value ${num} out of range [${min}, ${max}]`);
  }

  return num;
}

function parseField(
  fieldStr: string,
  fieldName: string,
  min: number,
  max: number,
  nameMap?: Record<string, number>,
  normalizeSevenToZero = false,
): ParsedField {
  const trimmed = fieldStr.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} field is empty`);
  }

  const values = new Set<number>();
  const isWildcard = trimmed === "*";
  const parts = trimmed.split(",");

  for (const part of parts) {
    if (!part) {
      throw new Error(`${fieldName} contains empty list element`);
    }

    const slashSegments = part.split("/");
    if (slashSegments.length > 2) {
      throw new Error(`${fieldName} has malformed step syntax "${part}"`);
    }

    const base = slashSegments[0];
    let step = 1;
    if (slashSegments.length === 2) {
      const stepStr = slashSegments[1];
      if (!/^\d+$/.test(stepStr)) {
        throw new Error(`${fieldName} has invalid step "${stepStr}"`);
      }
      step = Number.parseInt(stepStr, 10);
      if (step <= 0) {
        throw new Error(`${fieldName} step must be > 0`);
      }
    }

    let rangeStart: number;
    let rangeEnd: number;

    if (base === "*") {
      rangeStart = min;
      rangeEnd = max;
    } else if (base.includes("-")) {
      const bounds = base.split("-");
      if (bounds.length !== 2) {
        throw new Error(`${fieldName} has malformed range "${base}"`);
      }
      const rawStart = parseAtomicValue(bounds[0], min, max, nameMap, false);
      let rawEnd = parseAtomicValue(bounds[1], min, max, nameMap, false);

      // Allow Sunday as 7 at the end of a range like 5-7 (Fri-Sun)
      if (normalizeSevenToZero && rawStart === 7) {
        rangeStart = 0;
      } else {
        rangeStart = rawStart;
      }

      if (normalizeSevenToZero && rawEnd === 7) {
        rawEnd = 7;
      }

      if (rangeStart > rawEnd) {
        throw new Error(`${fieldName} range start ${rangeStart} exceeds end ${rawEnd}`);
      }
      rangeEnd = rawEnd;
    } else {
      const single = parseAtomicValue(base, min, max, nameMap, normalizeSevenToZero);
      rangeStart = single;
      rangeEnd = slashSegments.length === 2 ? max : single;
    }

    for (let v = rangeStart; v <= rangeEnd; v += step) {
      values.add(normalizeSevenToZero && v === 7 ? 0 : v);
    }
  }

  if (values.size === 0) {
    throw new Error(`${fieldName} produced no valid values`);
  }

  return { values, isWildcard };
}

function parseCronExpression(expression: string): ParsedCron {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new InvalidCronExpressionError(String(expression ?? ""), "expression must be a non-empty string");
  }

  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new InvalidCronExpressionError(
      expression,
      `expected exactly 5 fields (minute hour dom month dow), got ${fields.length}`,
    );
  }

  try {
    const minutes = parseField(fields[0], "minute", 0, 59);
    const hours = parseField(fields[1], "hour", 0, 23);
    const daysOfMonth = parseField(fields[2], "day-of-month", 1, 31);
    const months = parseField(fields[3], "month", 1, 12, MONTH_NAMES);
    const daysOfWeek = parseField(fields[4], "day-of-week", 0, 7, DOW_NAMES, true);

    return { minutes, hours, daysOfMonth, months, daysOfWeek };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new InvalidCronExpressionError(expression, reason);
  }
}

function matchesDay(parsed: ParsedCron, dom: number, dow: number): boolean {
  const domMatch = parsed.daysOfMonth.values.has(dom);
  const dowMatch = parsed.daysOfWeek.values.has(dow);

  if (parsed.daysOfMonth.isWildcard && parsed.daysOfWeek.isWildcard) {
    return true;
  }
  if (parsed.daysOfMonth.isWildcard) {
    return dowMatch;
  }
  if (parsed.daysOfWeek.isWildcard) {
    return domMatch;
  }
  // Standard Vixie cron semantics: if both DOM and DOW are restricted, match either.
  return domMatch || dowMatch;
}

/**
 * Computes the next `count` UTC fire timestamps strictly after `fromDate`
 * for a standard 5-field cron expression (`minute hour day-of-month month day-of-week`).
 *
 * Throws `InvalidCronExpressionError` if the expression is invalid.
 */
export function computeNextRuns(
  cronExpression: string,
  count = 5,
  fromDate: Date = new Date(),
): Date[] {
  const parsed = parseCronExpression(cronExpression);

  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`count must be a non-negative integer, received ${count}`);
  }
  if (!(fromDate instanceof Date) || Number.isNaN(fromDate.getTime())) {
    throw new Error("fromDate must be a valid Date");
  }
  if (count === 0) {
    return [];
  }

  const results: Date[] = [];

  // Start at the first whole minute strictly after fromDate
  const startMs = Math.floor(fromDate.getTime() / 60_000) * 60_000 + 60_000;
  let cursor = new Date(startMs);
  const maxYear = fromDate.getUTCFullYear() + 8;
  let guardIterations = 0;
  const maxIterations = 200_000;

  while (results.length < count && cursor.getUTCFullYear() <= maxYear && guardIterations < maxIterations) {
    guardIterations += 1;

    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1; // 1-12
    const dom = cursor.getUTCDate(); // 1-31
    const dow = cursor.getUTCDay(); // 0-6
    const hour = cursor.getUTCHours(); // 0-23
    const minute = cursor.getUTCMinutes(); // 0-59

    if (!parsed.months.values.has(month)) {
      // Jump to 1st of next month at 00:00 UTC
      cursor = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
      continue;
    }

    if (!matchesDay(parsed, dom, dow)) {
      // Jump to next day at 00:00 UTC
      cursor = new Date(Date.UTC(year, month - 1, dom + 1, 0, 0, 0, 0));
      continue;
    }

    if (!parsed.hours.values.has(hour)) {
      // Jump to next hour at :00 UTC
      cursor = new Date(Date.UTC(year, month - 1, dom, hour + 1, 0, 0, 0));
      continue;
    }

    if (!parsed.minutes.values.has(minute)) {
      // Advance by 1 minute
      cursor = new Date(cursor.getTime() + 60_000);
      continue;
    }

    results.push(new Date(cursor.getTime()));
    cursor = new Date(cursor.getTime() + 60_000);
  }

  return results;
}

export type PreviewableTask = Pick<
  TaskDefinition,
  "task_name" | "schedule" | "enabled" | "executionMode" | "flowTrigger"
>;

export interface DryRunOptions {
  fromDate?: Date;
  runsPerTask?: number;
  includeDisabled?: boolean;
  maxTotalEvents?: number;
}

export interface ScheduledFirePreview {
  taskName: string;
  schedule: string;
  executionMode: ExecutionMode;
  scheduledAt: Date;
  scheduledAtIso: string;
  flowId?: string;
}

export interface ScheduleValidationWarning {
  taskName: string;
  schedule: string;
  reason: string;
}

export interface DryRunScheduleResult {
  fromDate: Date;
  events: ScheduledFirePreview[];
  warnings: ScheduleValidationWarning[];
  skippedDisabled: string[];
}

/**
 * Performs an offline dry-run across a list of tasks, returning a chronologically
 * sorted preview of upcoming fire timestamps plus validation warnings for any
 * invalid or unmatchable cron expressions.
 */
export function dryRunSchedule(
  tasks: ReadonlyArray<PreviewableTask>,
  options: DryRunOptions = {},
): DryRunScheduleResult {
  const fromDate = options.fromDate ?? new Date();
  const runsPerTask = options.runsPerTask ?? 3;
  const includeDisabled = options.includeDisabled ?? false;

  const events: ScheduledFirePreview[] = [];
  const warnings: ScheduleValidationWarning[] = [];
  const skippedDisabled: string[] = [];

  for (const task of tasks) {
    if (!task.enabled && !includeDisabled) {
      skippedDisabled.push(task.task_name);
      continue;
    }

    try {
      const nextRuns = computeNextRuns(task.schedule, runsPerTask, fromDate);
      if (runsPerTask > 0 && nextRuns.length === 0) {
        warnings.push({
          taskName: task.task_name,
          schedule: task.schedule,
          reason: "Cron expression produced no matching fire dates within the search horizon",
        });
        continue;
      }

      const executionMode: ExecutionMode = task.executionMode ?? "llm";
      const flowId = executionMode === "flow_trigger" ? task.flowTrigger?.flowId : undefined;

      for (const scheduledAt of nextRuns) {
        events.push({
          taskName: task.task_name,
          schedule: task.schedule,
          executionMode,
          scheduledAt,
          scheduledAtIso: scheduledAt.toISOString(),
          ...(flowId !== undefined ? { flowId } : {}),
        });
      }
    } catch (err) {
      warnings.push({
        taskName: task.task_name,
        schedule: task.schedule,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  events.sort((a, b) => {
    const diff = a.scheduledAt.getTime() - b.scheduledAt.getTime();
    if (diff !== 0) {
      return diff;
    }
    return a.taskName.localeCompare(b.taskName);
  });

  const limitedEvents =
    options.maxTotalEvents !== undefined && options.maxTotalEvents >= 0
      ? events.slice(0, options.maxTotalEvents)
      : events;

  return {
    fromDate,
    events: limitedEvents,
    warnings,
    skippedDisabled,
  };
}
