import { getEnrichedQuota } from "./quotaService";
import { buildDailyReportMessages } from "./slackReport";
import { postToSlack } from "./slackClient";
import { tryAcquireLock } from "./dynamo";

/** Sends the daily report, de-duplicated across processes via a DynamoDB lock keyed on date + report hour. */
export async function sendDailyReport(hour: number): Promise<void> {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const lockId = `daily-report#${date}#${hour}`;

  const claimed = await tryAcquireLock(lockId, 60 * 60); // 1h TTL: slot is dead long before tomorrow's run
  if (!claimed) {
    console.log(`Daily report ${lockId} already sent by another process; skipping`);
    return;
  }

  const items = await getEnrichedQuota();
  const messages = buildDailyReportMessages(items);

  for (const message of messages) {
    await postToSlack(message);
  }

  console.log(`Posted daily Slack quota report (${items.length} teams, ${messages.length} messages)`);
}
