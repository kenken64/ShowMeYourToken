const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

export async function postToSlack(text: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.warn("SLACK_WEBHOOK_URL not set; skipping Slack post");
    return;
  }

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Slack webhook failed: ${res.status} ${body}`);
  }
}
