import { sendDailyReport } from "../dailyReport";

// Manual test run: use a distinct lock slot so it never blocks (or is blocked by) the scheduled reports.
sendDailyReport(-1)
  .then(() => {
    console.log("Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Failed to send Slack report:", err);
    process.exit(1);
  });
