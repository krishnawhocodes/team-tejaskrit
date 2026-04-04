import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { requireUser } from "../_lib/auth.js";

function bad(res: VercelResponse, status: number, msg: string) {
  return res.status(status).json({ ok: false, error: msg });
}

function ensureLatexLooksValid(tex: string) {
  const t = tex.trim();
  if (!t.includes("\\documentclass")) throw new Error("Invalid LaTeX: missing \\documentclass");
  if (!t.includes("\\begin{document}")) throw new Error("Invalid LaTeX: missing \\begin{document}");
  if (!t.includes("\\end{document}")) throw new Error("Invalid LaTeX: missing \\end{document}");
}

type Body = {
  applicationId?: string;
  latex?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");

  try {
    const u = await requireUser(req);
    const body = (req.body ?? {}) as Body;
    const applicationId = String(body.applicationId ?? "").trim();
    const latex = String(body.latex ?? "").trim();

    if (!applicationId) return bad(res, 400, "applicationId is required");
    if (!latex) return bad(res, 400, "latex is required");
    if (latex.length > 50000) return bad(res, 400, "LaTeX is too large");
    ensureLatexLooksValid(latex);

    const db = getAdminDb();
    const appRef = db.collection("applications").doc(applicationId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) return bad(res, 404, "Application not found");

    const app = appSnap.data() || {};
    if (app.userId !== u.uid) return bad(res, 403, "Forbidden");

    const now = new Date();
    await appRef.set(
      {
        status: "tailored",
        updatedAt: now,
        tailoredResume: {
          ...(app.tailoredResume || {}),
          latex,
          editedAt: now,
        },
      },
      { merge: true }
    );

    await appRef.collection("logs").add({
      action: "latex_saved",
      at: now,
      by: u.uid,
      meta: { source: "editor" },
    });

    return res.status(200).json({ ok: true, applicationId, updatedAt: now.toISOString() });
  } catch (e: any) {
    return bad(res, 500, e?.message ?? "Unknown error");
  }
}
