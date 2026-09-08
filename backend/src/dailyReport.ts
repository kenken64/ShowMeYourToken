import { getEnrichedQuota } from "./quotaService";
import { buildDailyReportMessages } from "./slackReport";
import { postToSlack } from "./slackClient";

export async function sendDailyReport(): Promise<void> {
  const items = await getEnrichedQuota();
  const messages = buildDailyReportMessages(items);

  for (const message of messages) {
    await postToSlack(message);
  }

  console.log(`Posted daily Slack quota report (${items.length} teams, ${messages.length} messages)`);
}
