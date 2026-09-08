function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asUtc - date.getTime()) / 60_000;
}

function msUntilNextRun(hour: number, timeZone: string): number {
  const now = new Date();
  const offsetMin = timeZoneOffsetMinutes(now, timeZone);
  const nowLocalMs = now.getTime() + offsetMin * 60_000;
  const nowLocal = new Date(nowLocalMs);

  let targetLocal = Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate(), hour, 0, 0);
  if (targetLocal <= nowLocalMs) {
    targetLocal += 24 * 60 * 60 * 1000;
  }

  const targetUtcMs = targetLocal - offsetMin * 60_000;
  return targetUtcMs - now.getTime();
}

/** Runs `task` once every 24h at the given local hour (0-23) in `timeZone`. */
export function startDailyScheduler(hour: number, timeZone: string, task: () => Promise<void>): void {
  const scheduleNext = () => {
    const delay = msUntilNextRun(hour, timeZone);
    console.log(`Next Slack quota report in ${(delay / 3_600_000).toFixed(2)}h (target ${hour}:00 ${timeZone})`);

    setTimeout(async () => {
      try {
        await task();
      } catch (err) {
        console.error("Daily Slack report failed:", err);
      } finally {
        scheduleNext();
      }
    }, delay);
  };

  scheduleNext();
}
