import { auth } from "@/lib/firebase";

async function getIdToken() {
  const u = auth.currentUser;
  if (!u) throw new Error("Not signed in");
  return await u.getIdToken();
}

export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const token = await getIdToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(input, { ...init, headers });
}

async function parseAuthedJson<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json as T;
}

export async function generateTailoredLatex(args: {
  jobId: string;
  matchScore?: number;
  matchReasons?: string[];
}) {
  const res = await authedFetch("/api/resume/generate-latex", {
    method: "POST",
    body: JSON.stringify(args),
  });
  return parseAuthedJson<{ ok: true; applicationId: string; genId: string }>(res);
}

export async function saveTailoredLatex(args: { applicationId: string; latex: string }) {
  const res = await authedFetch("/api/resume/save-latex", {
    method: "POST",
    body: JSON.stringify(args),
  });
  return parseAuthedJson<{ ok: true; applicationId: string; updatedAt: string }>(res);
}

export async function aiAssistTailoredLatex(args: { applicationId: string; prompt: string; latex: string }) {
  const res = await authedFetch("/api/resume/ai-assist", {
    method: "POST",
    body: JSON.stringify(args),
  });
  return parseAuthedJson<{ ok: true; latex: string; model: string }>(res);
}

export async function getLatexPreviewPdf(latex: string) {
  const res = await authedFetch("/api/resume/preview-pdf", {
    method: "POST",
    body: JSON.stringify({ latex }),
  });

  if (!res.ok) {
    const maybeJson = await res.json().catch(() => null);
    throw new Error(maybeJson?.error || `HTTP ${res.status}`);
  }

  return res.blob();
}

export async function downloadResumePdf(applicationId: string) {
  const res = await authedFetch(`/api/resume/pdf?applicationId=${encodeURIComponent(applicationId)}`);
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error(j?.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "resume.pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function refreshAiMatchScores(jobIds: string[]) {
  const token = await getIdToken();
  const res = await fetch("/api/match/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jobIds }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json as { ok: true; results: Array<{ jobId: string; score: number; reasons: string[] }> };
}


export async function generateAiTejaskritRecommendations() {
  const res = await authedFetch("/api/match/generate", {
    method: "POST",
  });
  return parseAuthedJson<{ ok: true; generationId: string; recommendationCount: number; aiRecommendationCount?: number; results: Array<{ jobId: string; score: number; reasons: string[] }> }>(res);
}
