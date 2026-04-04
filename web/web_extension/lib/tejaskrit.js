import { DEFAULT_CONFIG, STORAGE_KEYS } from "../config.js";
import { getFromStorage } from "./storage.js";
import { getValidIdToken, getSession } from "./auth.js";
import { addDoc, getDoc, setDocMerge } from "./firestore.js";
import { clampStr, nowIso } from "./utils.js";

async function loadConfig() {
  const saved = await getFromStorage("sync", STORAGE_KEYS.config);
  return {
    ...DEFAULT_CONFIG,
    ...(saved || {}),
    firebase: DEFAULT_CONFIG.firebase,
    backendBaseUrl: DEFAULT_CONFIG.backendBaseUrl,
  };
}

export async function getMyProfile() {
  const sess = await getSession();
  if (!sess?.uid) throw new Error("Not signed in");

  const uid = sess.uid;
  const [user, profile] = await Promise.all([
    getDoc(`users/${uid}`),
    getDoc(`users/${uid}/master_profile/main`),
  ]);

  return { uid, user: user || null, profile: profile || null };
}

export async function saveQuickProfile(args) {
  const sess = await getSession();
  if (!sess?.uid) throw new Error("Not signed in");

  const uid = sess.uid;

  await setDocMerge(
    `users/${uid}`,
    {
      uid,
      name: args.name || null,
      phone: args.phone || null,
      email: sess.email || args.email || null,
      role: "student",
      instituteId: null,
      prefs: {
        locations: args.location ? [args.location] : [],
      },
      consents: {
        resumeGeneration: args.resumeConsent !== false,
        jobMatching: true,
        shareWithTpo: false,
      },
    },
    ["updatedAt", "lastLoginAt"],
  );

  const edu = args.college
    ? [
        {
          institute: args.college,
          degree: args.degree || "",
          branch: args.branch || null,
          startYear: args.startYear ? Number(args.startYear) : null,
          endYear: args.endYear ? Number(args.endYear) : null,
          cgpa: args.cgpa ? Number(args.cgpa) : null,
        },
      ]
    : [];

  const skills = (args.skills || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 60);

  await setDocMerge(
    `users/${uid}/master_profile/main`,
    {
      headline: args.headline || "",
      summary: args.summary || "",
      links: {
        linkedin: args.linkedin || "",
        github: args.github || "",
        portfolio: args.portfolio || "",
      },
      skills,
      education: edu,
    },
    ["updatedAt"],
  );

  return true;
}

export async function upsertPrivateJob(jobId, jobInfo) {
  const sess = await getSession();
  if (!sess?.uid) throw new Error("Not signed in");

  const uid = sess.uid;

  const payload = {
    title: clampStr(jobInfo.title || "", 200) || "(Untitled role)",
    company: clampStr(jobInfo.company || "", 200) || "(Unknown company)",
    location: clampStr(jobInfo.location || "", 200) || "",
    jobType: jobInfo.jobType || "Internship",
    applyUrl: clampStr(jobInfo.applyUrl || "", 2000) || "",
    jdText: clampStr(jobInfo.jdText || "", 50000) || "",
    tags: Array.isArray(jobInfo.tags) ? jobInfo.tags.slice(0, 20) : [],
    source: "extension",
    sourceMeta: {
      pageUrl: jobInfo.pageUrl || jobInfo.applyUrl || "",
      detectedAt: nowIso(),
    },
    visibility: "private",
    ownerUid: uid,
    instituteId: null,
    status: "open",
  };

  const existing = await getDoc(`jobs/${jobId}`);
  const ts = existing
    ? ["updatedAt", "lastSeenAt"]
    : ["createdAt", "updatedAt", "postedAt", "lastSeenAt"];

  await setDocMerge(`jobs/${jobId}`, payload, ts);
  return jobId;
}

export async function upsertApplicationStatus(args) {
  const sess = await getSession();
  if (!sess?.uid) throw new Error("Not signed in");

  const uid = sess.uid;
  const appId = `${uid}__${args.jobId}`;

  const [user, existing] = await Promise.all([
    getDoc(`users/${uid}`),
    getDoc(`applications/${appId}`),
  ]);

  const instituteId = user?.instituteId ?? null;

  const keepAppliedAt =
    existing?.appliedAt instanceof Date ? existing.appliedAt : null;
  const appliedAt =
    args.status === "applied"
      ? keepAppliedAt || new Date()
      : keepAppliedAt || null;

  const data = {
    userId: uid,
    instituteId,
    jobId: args.jobId,
    status: args.status,
    origin: {
      type: "extension",
      pageUrl: args.pageUrl || "",
      detectedAts: args.detectedAts || "",
    },
    matchScore: existing?.matchScore ?? null,
    matchReasons: existing?.matchReasons ?? [],
    appliedAt,
  };

  const ts = existing ? ["updatedAt"] : ["createdAt", "updatedAt"];
  await setDocMerge(`applications/${appId}`, data, ts);

  await addDoc(`applications/${appId}/logs`, {
    action: "status_changed",
    to: args.status,
    by: uid,
    at: new Date(),
  });

  return appId;
}

export async function getApplication(appId) {
  return await getDoc(`applications/${appId}`);
}

export async function generateTailoredLatex(jobId, matchScore, matchReasons) {
  const cfg = await loadConfig();
  const base = (cfg.backendBaseUrl || "").replace(/\/$/, "");
  if (!base) throw new Error("Backend URL not configured");

  const token = await getValidIdToken();
  const res = await fetch(`${base}/api/resume/generate-latex`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jobId, matchScore, matchReasons }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok)
    throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

export async function downloadResumePdf(applicationId) {
  const cfg = await loadConfig();
  const base = (cfg.backendBaseUrl || "").replace(/\/$/, "");
  if (!base) throw new Error("Backend URL not configured");

  const token = await getValidIdToken();
  const res = await fetch(
    `${base}/api/resume/pdf?applicationId=${encodeURIComponent(applicationId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

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
