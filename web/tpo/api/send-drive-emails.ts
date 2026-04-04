import { requireUser } from "./_lib/auth.js";
import { getAdminDb } from "./_lib/firebaseAdmin.js";
import { sendDriveEmailsViaBrevo } from "./_lib/brevo.js";

function bad(res: any, status: number, error: string) {
  return res.status(status).json({ ok: false, error });
}

function toIso(x: any): string | undefined {
  if (!x) return undefined;
  if (typeof x?.toDate === "function") return x.toDate().toISOString();
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");

  try {
    const authed = await requireUser(req);
    const { jobId } = req.body || {};
    if (!jobId || typeof jobId !== "string") {
      return bad(res, 400, "jobId is required");
    }

    const db = getAdminDb();

    const [userSnap, jobSnap] = await Promise.all([
      db.collection("users").doc(authed.uid).get(),
      db.collection("jobs").doc(jobId).get(),
    ]);

    if (!userSnap.exists) return bad(res, 403, "TPO user not found");
    if (!jobSnap.exists) return bad(res, 404, "Job not found");

    const user = userSnap.data() || {};
    const job = jobSnap.data() || {};

    if (user.role !== "tpo")
      return bad(res, 403, "Only TPO users can send drive emails");
    if (!job.instituteId || user.instituteId !== job.instituteId) {
      return bad(
        res,
        403,
        "You can only email students for your own institute drives",
      );
    }

    const instituteSnap = await db
      .collection("institutes")
      .doc(job.instituteId)
      .get();
    const instituteName = instituteSnap.exists
      ? instituteSnap.data()?.name || "your institute"
      : "your institute";

    const membersSnap = await db
      .collection("institutes")
      .doc(job.instituteId)
      .collection("members")
      .where("role", "==", "student")
      .get();

    const eligibility = job.sourceMeta?.eligibility || {};
    const branches: string[] = Array.isArray(eligibility.branches)
      ? eligibility.branches
      : [];
    const batch: string | null = eligibility.batch || null;
    const minCgpa: number | null =
      typeof eligibility.minCgpa === "number" ? eligibility.minCgpa : null;

    const eligibleMembers = membersSnap.docs.filter((d) => {
      const m = d.data() || {};
      if (m.status === "inactive") return false;

      if (branches.length > 0) {
        const br = String(m.branch || "").trim();
        if (!branches.includes(br)) return false;
      }

      if (batch) {
        const bt = String(m.batch || "").trim();
        if (bt !== batch) return false;
      }

      if (typeof minCgpa === "number") {
        const cg = typeof m.cgpa === "number" ? m.cgpa : null;
        if (cg === null || cg < minCgpa) return false;
      }

      return true;
    });

    if (!eligibleMembers.length) {
      return res.status(200).json({
        ok: true,
        sentCount: 0,
        recipientCount: 0,
        skippedCount: 0,
      });
    }

    const userSnaps = await Promise.all(
      eligibleMembers.map((m) => db.collection("users").doc(m.id).get()),
    );

    const dedupe = new Set<string>();
    const recipients = userSnaps
      .map((snap, idx) => {
        if (!snap.exists) return null;
        const u = snap.data() || {};
        const email = String(u.email || "")
          .trim()
          .toLowerCase();
        if (!email) return null;
        if (dedupe.has(email)) return null;
        dedupe.add(email);

        const name = String(u.name || "").trim() || "Student";
        return {
          email,
          name,
          params: { studentName: name },
        };
      })
      .filter(Boolean) as Array<{
      email: string;
      name?: string | null;
      params: Record<string, string>;
    }>;

    const result = await sendDriveEmailsViaBrevo({
      recipients,
      drive: {
        jobId,
        title: String(job.title || ""),
        company: String(job.company || ""),
        location: String(job.location || ""),
        jobType: String(job.jobType || ""),
        ctcOrStipend: String(job.sourceMeta?.ctcOrStipend || ""),
        applyUrl: String(job.applyUrl || ""),
        deadlineIso: toIso(job.sourceMeta?.deadlineAt),
        instituteName,
      },
    });

    return res.status(200).json({
      ok: true,
      sentCount: result.sentCount,
      recipientCount: recipients.length,
      skippedCount: Math.max(eligibleMembers.length - recipients.length, 0),
      batchCalls: result.batchCalls,
    });
  } catch (e: any) {
    console.error("SEND DRIVE EMAILS ERROR:", e);
    return bad(res, 500, e?.message || "Unknown error");
  }
}
