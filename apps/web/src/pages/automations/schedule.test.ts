import { describe, expect, it } from "vitest";
import { buildAutomationRrule, parseAutomationRrule } from "./schedule";

describe("automation schedule helpers", () => {
  it("builds a daily RRULE", () => {
    expect(buildAutomationRrule({
      frequency: "daily",
      hour: 9,
      minute: 30,
      daysOfWeek: [],
    })).toBe("FREQ=DAILY;BYHOUR=9;BYMINUTE=30");
  });

  it("builds a weekly RRULE with sorted weekdays", () => {
    expect(buildAutomationRrule({
      frequency: "weekly",
      hour: 14,
      minute: 5,
      daysOfWeek: ["FR", "MO", "WE"],
    })).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=14;BYMINUTE=5");
  });

  it("parses a weekly RRULE", () => {
    expect(parseAutomationRrule("FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=14;BYMINUTE=5")).toEqual({
      frequency: "weekly",
      hour: 14,
      minute: 5,
      daysOfWeek: ["MO", "WE", "FR"],
    });
  });
});
