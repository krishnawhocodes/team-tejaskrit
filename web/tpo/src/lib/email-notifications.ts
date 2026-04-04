import { auth } from "@/lib/firebase";

export async function sendDriveEmails(jobId: string) {
  const user = auth.currentUser;
  if (!user) throw new Error("Not signed in");

  const idToken = await user.getIdToken();

  const res = await fetch("/api/send-drive-emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ jobId }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }

  return json as {
    ok: true;
    sentCount: number;
    recipientCount: number;
    skippedCount: number;
    batchCalls: number;
  };
}
