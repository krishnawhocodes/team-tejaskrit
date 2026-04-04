import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { requireUser } from "../_lib/auth.js";
import { groqChat } from "../_lib/groq.js";
import { stripUndefinedDeep } from "../_lib/util.js";

function bad(res: VercelResponse, status: number, msg: string) {
  return res.status(status).json({ ok: false, error: msg });
}

function cleanLatex(out: string) {
  const s = out.trim();
  const fenced = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "");
  return fenced.trim();
}

function ensureLatexLooksValid(tex: string) {
  const t = tex.trim();
  if (!t.includes("\\documentclass")) throw new Error("Invalid LaTeX: missing \\documentclass");
  if (!t.includes("\\begin{document}")) throw new Error("Invalid LaTeX: missing \\begin{document}");
  if (!t.includes("\\end{document}")) throw new Error("Invalid LaTeX: missing \\end{document}");
}

function stripJobRef(jobId: string) {
  return jobId.replace(/^\/?jobs\//, "");
}

type Body = {
  applicationId?: string;
  prompt?: string;
  latex?: string;
};

function buildAssistPrompt(args: {
  user: any;
  profile: any;
  job: any;
  currentLatex: string;
  prompt: string;
}) {
  const candidate = {
    name: args.user?.name || "",
    email: args.user?.email || "",
    phone: args.user?.phone || "",
    links: args.profile?.links || {},
    headline: args.profile?.headline || "",
    summary: args.profile?.summary || "",
    skills: args.profile?.skills || [],
    education: args.profile?.education || [],
    experience: args.profile?.experience || [],
    projects: args.profile?.projects || [],
    achievements: args.profile?.achievements || [],
  };

  const jobInfo = {
    title: args.job?.title || "",
    company: args.job?.company || "",
    location: args.job?.location || "",
    jobType: args.job?.jobType || "",
    tags: args.job?.tags || [],
    description: args.job?.jdText || "",
  };

  const system =
    "You are an expert ATS resume editor working inside a LaTeX editor. " +
    "Return ONLY the full updated LaTeX document, with no markdown fences or explanations. " +
    "Keep the document pdflatex-compatible. Use only safe resume packages like geometry, hyperref, enumitem, xcolor. " +
    "Preserve factual correctness, never invent achievements, dates, or metrics. " +
    "Apply the user's requested modification while keeping the resume concise, relevant to the job, and one-page friendly whenever possible.";

  const userMsg =
    "Update the current tailored resume using the user's instruction.\n\n" +
    `User instruction:\n${args.prompt.trim()}\n\n` +
    "Master profile JSON (source of truth):\n" +
    JSON.stringify(candidate, null, 2) +
    "\n\nJob JSON:\n" +
    JSON.stringify(jobInfo, null, 2) +
    "\n\nCurrent LaTeX resume:\n" +
    args.currentLatex +
    "\n\nRequirements:\n" +
    "- Output ONLY the full updated LaTeX.\n" +
    "- Keep pdflatex compatibility.\n" +
    "- Do not add facts not grounded in the provided profile/job/current resume.\n" +
    "- Preserve useful existing sections unless the instruction clearly changes them.\n";

  return { system, user: userMsg };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");

  try {
    const authed = await requireUser(req);
    const body = (req.body ?? {}) as Body;
    const applicationId = String(body.applicationId ?? "").trim();
    const prompt = String(body.prompt ?? "").trim();
    const currentLatex = String(body.latex ?? "").trim();

    if (!applicationId) return bad(res, 400, "applicationId is required");
    if (!prompt) return bad(res, 400, "prompt is required");
    if (!currentLatex) return bad(res, 400, "latex is required");
    if (prompt.length > 4000) return bad(res, 400, "Prompt is too long");
    if (currentLatex.length > 50000) return bad(res, 400, "LaTeX is too large");

    const db = getAdminDb();
    const userRef = db.collection("users").doc(authed.uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return bad(res, 404, "User doc not found");
    const user = userSnap.data() || {};
    if (user?.consents?.resumeGeneration === false) {
      return bad(res, 403, "Resume generation is disabled in Data & Privacy");
    }

    const appRef = db.collection("applications").doc(applicationId);
    const appSnap = await appRef.get();
    if (!appSnap.exists) return bad(res, 404, "Application not found");
    const app = appSnap.data() || {};
    if (app.userId !== authed.uid) return bad(res, 403, "Forbidden");

    const profileRef = db.collection("users").doc(authed.uid).collection("master_profile").doc("main");
    const profileSnap = await profileRef.get();
    const profile = profileSnap.exists ? profileSnap.data() : null;
    if (!profile) return bad(res, 400, "Master profile not found. Complete onboarding first.");

    const jobId = stripJobRef(String(app.jobId ?? "").trim());
    if (!jobId) return bad(res, 400, "Application jobId not found");
    const jobSnap = await db.collection("jobs").doc(jobId).get();
    if (!jobSnap.exists) return bad(res, 404, "Job not found");
    const job = jobSnap.data() || {};

    const built = buildAssistPrompt({ user, profile, job, currentLatex, prompt });
    const model = "llama-3.3-70b-versatile";
    const raw = await groqChat({
      model,
      messages: [
        { role: "system", content: built.system },
        { role: "user", content: built.user },
      ],
      temperature: 0.15,
      maxTokens: 2600,
    });

    const latex = cleanLatex(raw);
    ensureLatexLooksValid(latex);

    const now = new Date();
    const genRef = await db.collection("resume_generations").add(
      stripUndefinedDeep({
        userId: authed.uid,
        jobId,
        applicationId,
        model,
        promptVersion: "editor-ai-assist-v1",
        status: "success",
        kind: "editor_ai_assist",
        prompt,
        createdAt: now,
      })
    );

    await appRef.collection("logs").add({
      action: "resume_ai_assisted",
      at: now,
      by: authed.uid,
      meta: { genId: genRef.id, model },
    });

    return res.status(200).json({ ok: true, latex, model });
  } catch (e: any) {
    return bad(res, 500, e?.message ?? "Unknown error");
  }
}
