import type { Firestore } from "firebase-admin/firestore";

export type RecommendationBundleJobSnapshot = {
  jobId: string;
  title: string;
  company: string;
  location?: string;
  jobType?: string;
  applyUrl?: string;
  source?: string;
  visibility?: string;
  lastSeenAtMs: number;
  description: string;
  skills: string[];
  matchScore: number;
  matchReasons: string[];
  localScore: number;
  aiScore?: number;
};

export type VisibleJobRow = { id: string; data: any };

export function clip(s: string, n: number) {
  const t = (s ?? "").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function normalizeToken(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9+#.]/g, "").trim();
}

function tokenize(text: string) {
  return Array.from(
    new Set(
      String(text ?? "")
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 2)
    )
  );
}

function overlapScore(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b.map(normalizeToken).filter(Boolean));
  const hits = a.map(normalizeToken).filter((x) => x && setB.has(x)).length;
  return Math.min(100, Math.round((hits / Math.max(3, Math.min(a.length, 12))) * 100));
}

function textContainsAny(text: string, needles: string[]) {
  const hay = text.toLowerCase();
  return needles.some((n) => n && hay.includes(n.toLowerCase()));
}

export function tsMillis(x: any): number {
  if (!x) return 0;
  if (typeof x?.toMillis === "function") return x.toMillis();
  if (x instanceof Date) return x.getTime();
  return 0;
}

export function jobSortKey(j: any): number {
  return tsMillis(j.lastSeenAt) || tsMillis(j.postedAt) || tsMillis(j.createdAt) || tsMillis(j.updatedAt) || 0;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function buildCandidateText(user: any, profile: any) {
  const skills = Array.isArray(profile?.skills) ? profile.skills.join(", ") : "";
  const edu = Array.isArray(profile?.education)
    ? profile.education
        .map((e: any) => `${e.degree ?? ""} ${e.branch ?? ""} @ ${e.institute ?? ""} (${e.startYear ?? ""}-${e.endYear ?? ""}) CGPA:${e.cgpa ?? ""}`)
        .join(" | ")
    : "";
  const exp = Array.isArray(profile?.experience)
    ? profile.experience
        .slice(0, 4)
        .map((x: any) => `${x.title ?? ""} @ ${x.company ?? ""}: ${(x.bullets ?? []).slice(0, 3).join("; ")}`)
        .join(" | ")
    : "";
  const projects = Array.isArray(profile?.projects)
    ? profile.projects
        .slice(0, 4)
        .map((p: any) => `${p.name ?? ""} (${(p.tech ?? []).join(", ")}): ${(p.bullets ?? []).slice(0, 3).join("; ")}`)
        .join(" | ")
    : "";

  const masterText = profile?.masterText ? String(profile.masterText) : "";

  return clip(
    [
      `Name: ${user?.name ?? ""}`,
      `Email: ${user?.email ?? ""}`,
      `Headline: ${profile?.headline ?? ""}`,
      `Summary: ${profile?.summary ?? ""}`,
      `Skills: ${skills}`,
      `Education: ${edu}`,
      `Experience: ${exp}`,
      `Projects: ${projects}`,
      masterText ? `MasterText: ${masterText}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    9000
  );
}

export function computeLocalRecommendation(job: any, user: any, profile: any) {
  const skillTokens = Array.isArray(profile?.skills) ? profile.skills : [];
  const projectTokens = Array.isArray(profile?.projects)
    ? profile.projects.flatMap((p: any) => [p?.name ?? "", ...(Array.isArray(p?.tech) ? p.tech : []), ...((p?.bullets ?? []) as string[])])
    : [];
  const experienceTokens = Array.isArray(profile?.experience)
    ? profile.experience.flatMap((x: any) => [x?.title ?? "", x?.company ?? "", ...((x?.bullets ?? []) as string[])])
    : [];
  const educationTokens = Array.isArray(profile?.education)
    ? profile.education.flatMap((e: any) => [e?.degree ?? "", e?.branch ?? "", e?.institute ?? ""])
    : [];

  const profileText = [
    profile?.headline ?? "",
    profile?.summary ?? "",
    profile?.masterText ?? "",
    skillTokens.join(" "),
    projectTokens.join(" "),
    experienceTokens.join(" "),
    educationTokens.join(" "),
  ].join(" \n ");

  const jobText = [job?.title ?? "", job?.company ?? "", job?.location ?? "", job?.jobType ?? "", job?.jdText ?? "", ...(job?.tags ?? [])].join(" \n ");

  const jobTagTokens = tokenize((job?.tags ?? []).join(" "));
  const jobTextTokens = tokenize(jobText).slice(0, 70);
  const profileSkillTokens = tokenize(skillTokens.join(" "));
  const profileProjectTokens = tokenize(projectTokens.join(" "));
  const profileExpTokens = tokenize(experienceTokens.join(" "));
  const profileEduTokens = tokenize(educationTokens.join(" "));

  const skillsScore = overlapScore(profileSkillTokens, jobTagTokens.length ? jobTagTokens : jobTextTokens);
  const projectScore = overlapScore(profileProjectTokens, jobTagTokens.concat(jobTextTokens));
  const experienceScore = overlapScore(profileExpTokens, jobTextTokens);
  const educationScore = overlapScore(profileEduTokens, jobTextTokens);

  const titleTokens = tokenize(String(job?.title ?? ""));
  const titleFit = overlapScore(titleTokens, tokenize(profileText));

  const prefsLocations = Array.isArray(user?.prefs?.locations) ? user.prefs.locations : [];
  const prefsJobTypes = Array.isArray(user?.prefs?.jobTypes) ? user.prefs.jobTypes : [];
  const locationFit = prefsLocations.length
    ? textContainsAny(String(job?.location ?? ""), prefsLocations) || textContainsAny(String(job?.jdText ?? ""), prefsLocations)
      ? 100
      : 20
    : 55;
  const typeFit = prefsJobTypes.length ? (prefsJobTypes.includes(job?.jobType) ? 100 : 25) : 60;

  const recencyHours = Math.max(0, (Date.now() - jobSortKey(job)) / 36e5);
  const recencyScore = recencyHours <= 24 ? 100 : recencyHours <= 72 ? 82 : recencyHours <= 168 ? 68 : 55;

  const score = Math.round(
    skillsScore * 0.35 +
      projectScore * 0.18 +
      experienceScore * 0.16 +
      titleFit * 0.1 +
      educationScore * 0.07 +
      locationFit * 0.05 +
      typeFit * 0.04 +
      recencyScore * 0.05
  );

  const matchedSkills = skillTokens.filter((s: string) => textContainsAny(jobText, [s])).slice(0, 3);
  const matchedProjectTech = Array.from(new Set(projectTokens.filter((s: string) => textContainsAny(jobText, [s])))).slice(0, 2);
  const reasons = [
    matchedSkills.length ? `Matched skills: ${matchedSkills.join(", ")}` : "Profile aligns with the required stack",
    matchedProjectTech.length ? `Project overlap: ${matchedProjectTech.join(", ")}` : "Projects support this role",
    titleFit >= 45 ? `Role title aligns with your profile` : "Transferable experience is relevant",
    typeFit >= 90 ? `Matches your preferred job type` : locationFit >= 90 ? `Location aligns with your preferences` : `Recently active opening`,
  ]
    .filter(Boolean)
    .slice(0, 4);

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

export function buildBundleJobSnapshot(args: {
  jobId: string;
  job: any;
  finalScore: number;
  localScore: number;
  aiScore?: number;
  reasons: string[];
}) : RecommendationBundleJobSnapshot {
  const { jobId, job, finalScore, localScore, aiScore, reasons } = args;
  return {
    jobId,
    title: String(job?.title ?? ""),
    company: String(job?.company ?? ""),
    location: job?.location ? String(job.location) : undefined,
    jobType: job?.jobType ? String(job.jobType) : undefined,
    applyUrl: job?.applyUrl ? String(job.applyUrl) : undefined,
    source: job?.source ? String(job.source) : undefined,
    visibility: job?.visibility ? String(job.visibility) : undefined,
    lastSeenAtMs: jobSortKey(job),
    description: clip(String(job?.jdText ?? ""), 900),
    skills: Array.isArray(job?.tags) ? job.tags.map(String).slice(0, 12) : [],
    matchScore: Math.max(0, Math.min(100, Math.round(finalScore))),
    matchReasons: Array.isArray(reasons) ? reasons.map((x) => clip(String(x), 120)).slice(0, 4) : [],
    localScore: Math.max(0, Math.min(100, Math.round(localScore))),
    aiScore: aiScore === undefined ? undefined : Math.max(0, Math.min(100, Math.round(aiScore))),
  };
}

export async function listVisibleJobsForUser(db: Firestore, args: { uid: string; instituteId?: string | null; take?: number }) {
  const { uid, instituteId, take = 150 } = args;
  const jobsCol = db.collection("jobs");
  const queryTake = Math.min(Math.max(take, 1), 150);
  const [pub, inst, priv] = await Promise.all([
    jobsCol.where("visibility", "==", "public").limit(queryTake).get(),
    instituteId ? jobsCol.where("instituteId", "==", instituteId).limit(queryTake).get() : Promise.resolve(null),
    jobsCol.where("ownerUid", "==", uid).limit(queryTake).get(),
  ]);

  const map = new Map<string, VisibleJobRow>();
  for (const doc of pub.docs) map.set(doc.id, { id: doc.id, data: doc.data() });
  for (const doc of inst?.docs ?? []) {
    const data = doc.data();
    if (data?.visibility === "institute") map.set(doc.id, { id: doc.id, data });
  }
  for (const doc of priv.docs) {
    const data = doc.data();
    if (data?.visibility === "private") map.set(doc.id, { id: doc.id, data });
  }

  return Array.from(map.values())
    .sort((a, b) => jobSortKey(b.data) - jobSortKey(a.data))
    .slice(0, take);
}
