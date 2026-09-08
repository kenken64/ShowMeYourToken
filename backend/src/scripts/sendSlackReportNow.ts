import { sendDailyReport } from "../dailyReport";

sendDailyReport()
  .then(() => {
    console.log("Done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Failed to send Slack report:", err);
    process.exit(1);
  });
