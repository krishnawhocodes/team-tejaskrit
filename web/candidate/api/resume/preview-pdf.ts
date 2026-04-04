import type { VercelRequest, VercelResponse } from "@vercel/node";
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

type Body = { latex?: string };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");

  try {
    await requireUser(req);
    const body = (req.body ?? {}) as Body;
    const latex = String(body.latex ?? "").trim();
    if (!latex) return bad(res, 400, "latex is required");
    if (latex.length > 50000) return bad(res, 400, "LaTeX is too large");
    ensureLatexLooksValid(latex);

    const compileUrl = `https://latexonline.cc/compile?text=${encodeURIComponent(latex)}&command=pdflatex&force=true`;
    const r = await fetch(compileUrl, { method: "GET" });
    if (!r.ok) {
      const errText = await r.text().catch(() => r.statusText);
      return bad(res, 422, `Preview compile failed: ${errText}`);
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);
  } catch (e: any) {
    return bad(res, 500, e?.message ?? "Unknown error");
  }
}
