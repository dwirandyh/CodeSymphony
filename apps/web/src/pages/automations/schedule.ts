export type AutomationScheduleFrequency = "daily" | "weekly" | "hourly";

export type AutomationScheduleDraft = {
  frequency: AutomationScheduleFrequency;
  hour: number;
  minute: number;
  daysOfWeek: string[];
};

export const AUTOMATION_WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export function buildAutomationRrule(draft: AutomationScheduleDraft): string {
  const byHour = clampInteger(draft.hour, 0, 23);
  const byMinute = clampInteger(draft.minute, 0, 59);

  if (draft.frequency === "hourly") {
    return `FREQ=HOURLY;BYMINUTE=${byMinute}`;
  }

  if (draft.frequency === "weekly") {
    const daysOfWeek = [...new Set(draft.daysOfWeek)]
      .filter((day) => AUTOMATION_WEEKDAYS.includes(day as (typeof AUTOMATION_WEEKDAYS)[number]))
      .sort((left, right) => AUTOMATION_WEEKDAYS.indexOf(left as (typeof AUTOMATION_WEEKDAYS)[number]) - AUTOMATION_WEEKDAYS.indexOf(right as (typeof AUTOMATION_WEEKDAYS)[number]));
    const normalizedDays = daysOfWeek.length > 0 ? daysOfWeek : ["MO"];
    return `FREQ=WEEKLY;BYDAY=${normalizedDays.join(",")};BYHOUR=${byHour};BYMINUTE=${byMinute}`;
  }

  return `FREQ=DAILY;BYHOUR=${byHour};BYMINUTE=${byMinute}`;
}

export function parseAutomationRrule(input: string): AutomationScheduleDraft {
  const kv = new Map<string, string>();
  for (const part of input.split(";")) {
    const [key, value] = part.split("=", 2);
    if (!key || !value) {
      continue;
    }
    kv.set(key.toUpperCase(), value.toUpperCase());
  }

  const freq = kv.get("FREQ");
  const hour = clampInteger(Number.parseInt(kv.get("BYHOUR") ?? "0", 10), 0, 23);
  const minute = clampInteger(Number.parseInt(kv.get("BYMINUTE") ?? "0", 10), 0, 59);

  if (freq === "HOURLY") {
    return {
      frequency: "hourly",
      hour: 0,
      minute,
      daysOfWeek: [],
    };
  }

  if (freq === "WEEKLY") {
    const daysOfWeek = (kv.get("BYDAY") ?? "")
      .split(",")
      .map((day) => day.trim())
      .filter((day) => AUTOMATION_WEEKDAYS.includes(day as (typeof AUTOMATION_WEEKDAYS)[number]));

    return {
      frequency: "weekly",
      hour,
      minute,
      daysOfWeek,
    };
  }

  return {
    frequency: "daily",
    hour,
    minute,
    daysOfWeek: [],
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
