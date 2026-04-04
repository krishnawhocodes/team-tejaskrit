// src/lib/firestore.ts
// Firestore data-access layer for Tejaskrit Candidate Panel
// This version avoids composite-index dependencies by not using orderBy with where filters.

import {
  collection,
  collectionGroup,
  doc,
  deleteDoc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  addDoc,
  Timestamp,
} from "firebase/firestore";
import type { User } from "firebase/auth";

import { db } from "./firebase";
import type {
  ApplicationDoc,
  ApplicationStatusKey,
  EventDoc,
  InstituteDoc,
  JobDoc,
  MasterProfileDoc,
  NotificationDoc,
  RecommendationDoc,
  RecommendationGenerationDoc,
  RecommendationMetaDoc,
  UserDoc,
} from "./types";
// slugify previously used for institute doc IDs; now institutes are owned by TPO.

// ---------------------------
// Helpers
// ---------------------------

// Firestore does NOT allow `undefined` values anywhere in an object.
function stripUndefinedDeep<T>(value: T): T {
  if (value === undefined) return undefined as unknown as T;
  if (value === null) return value;
  if (Array.isArray(value)) {
    return value.filter((v) => v !== undefined).map((v) => stripUndefinedDeep(v)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      const vv = stripUndefinedDeep(v);
      if (vv === undefined) continue;
      out[k] = vv;
    }
    return out as unknown as T;
  }
  return value;
}

function stripRef(prefix: string, val: string) {
  return val.startsWith(prefix) ? val.slice(prefix.length) : val;
}

export function jobIdFromAny(jobIdOrRef: string) {
  return stripRef("jobs/", stripRef("/jobs/", jobIdOrRef));
}

function tsMillis(x: any): number {
  if (!x) return 0;
  if (typeof x?.toMillis === "function") return x.toMillis();
  if (x instanceof Date) return x.getTime();
  return 0;
}

function jobSortKey(j: JobDoc): number {
  const a: any = j;
  return tsMillis(a.lastSeenAt) || tsMillis(a.postedAt) || tsMillis(a.createdAt) || tsMillis(a.updatedAt) || 0;
}

// ---------------------------
// Users
// ---------------------------

export async function ensureUserDoc(authUser: User): Promise<UserDoc> {
  const ref = doc(db, "users", authUser.uid);
  const snap = await getDoc(ref);

  const base: UserDoc = {
    uid: authUser.uid,
    email: authUser.email ?? undefined,
    name: authUser.displayName ?? undefined,
    photoUrl: authUser.photoURL ?? undefined,
    role: "student",
    consents: {
      resumeGeneration: true,
      jobMatching: true,
      shareWithTpo: false,
    },
  };

  if (!snap.exists()) {
    await setDoc(
      ref,
      stripUndefinedDeep({
        ...base,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastLoginAt: serverTimestamp(),
      }),
      { merge: true }
    );
    return base;
  }

  await updateDoc(ref, { lastLoginAt: serverTimestamp(), updatedAt: serverTimestamp() });

  const existing = snap.data() as UserDoc;
  return {
    ...base,
    ...existing,
    uid: authUser.uid,
    email: authUser.email ?? existing.email,
    name: authUser.displayName ?? existing.name,
    photoUrl: authUser.photoURL ?? existing.photoUrl,
  };
}

export async function getUserDoc(uid: string): Promise<UserDoc | null> {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? (snap.data() as UserDoc) : null;
}

// ---------------------------
// Master Profile
// ---------------------------

export async function getMasterProfile(uid: string): Promise<MasterProfileDoc | null> {
  const snap = await getDoc(doc(db, "users", uid, "master_profile", "main"));
  return snap.exists() ? (snap.data() as MasterProfileDoc) : null;
}

export async function saveMasterProfile(uid: string, profile: MasterProfileDoc) {
  await setDoc(
    doc(db, "users", uid, "master_profile", "main"),
    stripUndefinedDeep({ ...profile, updatedAt: serverTimestamp() }),
    { merge: true }
  );
}

export async function saveUserConsents(uid: string, consents: UserDoc["consents"]) {
  await updateDoc(doc(db, "users", uid), { consents, updatedAt: serverTimestamp() } as any);
}

// ---------------------------
// Institute connection
// ---------------------------

/**
 * ✅ Candidate-side institute picker
 * Only show colleges that have a configured TPO.
 * Primary: institutes where hasTpo == true
 * Fallback (legacy): infer institutes via collectionGroup members where role == 'tpo'.
 */
export async function listConfiguredInstitutes(take = 200): Promise<Array<{ id: string; data: InstituteDoc }>> {
  // 1) Prefer explicit flags
  try {
    const q1 = query(collection(db, "institutes"), where("hasTpo", "==", true), limit(take));
    const snap1 = await getDocs(q1);
    const rows1 = snap1.docs
      .map((d) => ({ id: d.id, data: d.data() as InstituteDoc }))
      .filter((r) => (r.data.isActive ?? true) && (r.data.isConfigured ?? true));
    if (rows1.length > 0) return rows1.sort((a, b) => (a.data.name ?? "").localeCompare(b.data.name ?? ""));
  } catch {
    // ignore and fallback
  }

  // 2) Legacy fallback: institutes that have at least one TPO member
  const q2 = query(collectionGroup(db, "members"), where("role", "==", "tpo"), limit(take));
  const snap2 = await getDocs(q2);
  const instituteIds = Array.from(
    new Set(
      snap2.docs
        .map((d) => d.ref.path.split("/")?.[1]) // institutes/{instituteId}/members/{uid}
        .filter(Boolean)
    )
  );

  const rows: Array<{ id: string; data: InstituteDoc }> = [];
  await Promise.all(
    instituteIds.map(async (id) => {
      const s = await getDoc(doc(db, "institutes", id));
      if (s.exists()) {
        const data = s.data() as InstituteDoc;
        if ((data.isActive ?? true) && (data.domainsAllowed?.length ?? 0) > 0) rows.push({ id, data });
      }
    })
  );
  return rows.sort((a, b) => (a.data.name ?? "").localeCompare(b.data.name ?? ""));
}

export async function getInstituteById(instituteId: string): Promise<InstituteDoc | null> {
  const snap = await getDoc(doc(db, "institutes", instituteId));
  return snap.exists() ? (snap.data() as InstituteDoc) : null;
}

/**
 * ✅ Connect a candidate to an existing institute (prevents duplicate institute docs).
 */
export async function connectUserToInstituteExisting(args: {
  uid: string;
  instituteId: string;
  branch?: string;
  batch?: string;
  cgpa?: number;
}) {
  const { uid, instituteId, branch, batch: batchYear, cgpa } = args;
  if (!instituteId) throw new Error("Select your institute");

  const inst = await getInstituteById(instituteId);
  if (!inst) throw new Error("Selected institute not found. Ask your TPO to register it first.");

  const userRef = doc(db, "users", uid);
  const memRef = doc(db, "institutes", instituteId, "members", uid);

  const batch = writeBatch(db);
  batch.set(
    memRef,
    {
      uid,
      role: "student",
      branch: branch?.trim() ?? "",
      batch: batchYear?.trim() ?? "",
      cgpa: typeof cgpa === "number" ? cgpa : null,
      status: "active",
      joinedAt: serverTimestamp(),
    },
    { merge: true }
  );
  batch.set(
    userRef,
    {
      instituteId,
      role: "student",
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  await batch.commit();
  return instituteId;
}

export async function saveOnboarding(
  uid: string,
  patch: Partial<UserDoc>,
  profilePatch: MasterProfileDoc,
  instituteMember?: {
    instituteId?: string | null;
    instituteName?: string;
    branch?: string;
    batch?: string;
    cgpa?: number;
  }
) {
  const userRef = doc(db, "users", uid);
  const masterRef = doc(db, "users", uid, "master_profile", "main");

  const batch = writeBatch(db);
  batch.set(
    userRef,
    stripUndefinedDeep({
      ...patch,
      role: patch.role ?? "student",
      onboardedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
    { merge: true }
  );
  batch.set(masterRef, stripUndefinedDeep({ ...profilePatch, updatedAt: serverTimestamp() }), { merge: true });

  if (instituteMember?.instituteId) {
    const instituteId = instituteMember.instituteId;
    // IMPORTANT: Candidate flow should NOT create/overwrite institute docs.
    // Institutes are owned/configured by TPO panel.
    const memRef = doc(db, "institutes", instituteId, "members", uid);
    batch.set(
      memRef,
      {
        uid,
        role: "student",
        branch: instituteMember.branch ?? "",
        batch: instituteMember.batch ?? "",
        cgpa: instituteMember.cgpa ?? null,
        status: "active",
        joinedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }

  await batch.commit();
}

// ---------------------------
// Recommendations
// ---------------------------

export async function listRecommendations(uid: string, take = 50): Promise<Array<{ id: string; data: RecommendationDoc }>> {
  const q = query(collection(db, "users", uid, "recommendations"), limit(take));
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() as RecommendationDoc }));
  return rows.sort((a, b) => ((b.data.finalScore ?? b.data.score) || 0) - ((a.data.finalScore ?? a.data.score) || 0));
}

export async function getRecommendationMeta(uid: string): Promise<RecommendationMetaDoc | null> {
  const snap = await getDoc(doc(db, "users", uid, "recommendation_meta", "main"));
  return snap.exists() ? (snap.data() as RecommendationMetaDoc) : null;
}

export async function getRecommendationGeneration(uid: string, generationId: string): Promise<RecommendationGenerationDoc | null> {
  if (!generationId) return null;
  const snap = await getDoc(doc(db, "users", uid, "recommendation_generations", generationId));
  return snap.exists() ? (snap.data() as RecommendationGenerationDoc) : null;
}

export async function getActiveRecommendationBundle(uid: string): Promise<{
  meta: RecommendationMetaDoc | null;
  bundle: RecommendationGenerationDoc | null;
}> {
  const meta = await getRecommendationMeta(uid);
  const activeGenerationId = meta?.activeGenerationId ?? meta?.generationId;
  if (!activeGenerationId) return { meta, bundle: null };
  const bundle = await getRecommendationGeneration(uid, activeGenerationId);
  return { meta, bundle };
}

export async function listActiveRecommendations(uid: string, take = 50): Promise<{
  meta: RecommendationMetaDoc | null;
  rows: Array<{ id: string; data: RecommendationDoc }>;
}> {
  const [meta, rows] = await Promise.all([getRecommendationMeta(uid), listRecommendations(uid, Math.max(take, 50))]);
  const activeGenerationId = meta?.activeGenerationId ?? meta?.generationId;
  const filtered = activeGenerationId
    ? rows.filter((row) => (row.data.generationId ?? "") === activeGenerationId)
    : rows;
  return {
    meta,
    rows: filtered
      .sort((a, b) => ((b.data.finalScore ?? b.data.score) || 0) - ((a.data.finalScore ?? a.data.score) || 0))
      .slice(0, take),
  };
}

// ---------------------------
// Jobs
// ---------------------------

export async function listPublicJobs(take = 50): Promise<Array<{ id: string; data: JobDoc }>> {
  const q = query(collection(db, "jobs"), where("visibility", "==", "public"), limit(take));
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() as JobDoc }));
  return rows.sort((a, b) => jobSortKey(b.data) - jobSortKey(a.data));
}

export async function listInstituteJobs(instituteId: string, take = 50): Promise<Array<{ id: string; data: JobDoc }>> {
  const q = query(collection(db, "jobs"), where("instituteId", "==", instituteId), limit(take));
  const snap = await getDocs(q);
  const rows = snap.docs
    .map((d) => ({ id: d.id, data: d.data() as JobDoc }))
    .filter((r) => r.data.visibility === "institute");
  return rows.sort((a, b) => jobSortKey(b.data) - jobSortKey(a.data));
}

export async function listPrivateJobs(uid: string, take = 50): Promise<Array<{ id: string; data: JobDoc }>> {
  const q = query(collection(db, "jobs"), where("ownerUid", "==", uid), limit(take));
  const snap = await getDocs(q);
  const rows = snap.docs
    .map((d) => ({ id: d.id, data: d.data() as JobDoc }))
    .filter((r) => r.data.visibility === "private");
  return rows.sort((a, b) => jobSortKey(b.data) - jobSortKey(a.data));
}

export async function listJobsFeedForUser(args: {
  uid: string;
  instituteId?: string | null;
  take?: number;
}): Promise<Array<{ id: string; data: JobDoc }>> {
  const { uid, instituteId, take = 100 } = args;
  const [pub, inst, priv] = await Promise.all([
    listPublicJobs(Math.min(take, 100)),
    instituteId ? listInstituteJobs(instituteId, Math.min(take, 100)) : Promise.resolve([]),
    listPrivateJobs(uid, Math.min(take, 100)),
  ]);
  const map = new Map<string, { id: string; data: JobDoc }>();
  [...pub, ...inst, ...priv].forEach((r) => map.set(r.id, r));
  return Array.from(map.values()).sort((a, b) => jobSortKey(b.data) - jobSortKey(a.data)).slice(0, take);
}

export async function getJobsByIds(ids: string[]): Promise<Record<string, JobDoc>> {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  const out: Record<string, JobDoc> = {};
  await Promise.all(
    unique.map(async (id) => {
      const snap = await getDoc(doc(db, "jobs", id));
      if (snap.exists()) out[id] = snap.data() as JobDoc;
    })
  );
  return out;
}

// ---------------------------
// Applications
// ---------------------------

export async function listApplications(uid: string): Promise<Array<{ id: string; data: ApplicationDoc }>> {
  const q = query(collection(db, "applications"), where("userId", "==", uid), limit(300));
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() as ApplicationDoc }));
  return rows.sort((a, b) => tsMillis((b.data as any).updatedAt) - tsMillis((a.data as any).updatedAt));
}

export async function upsertApplicationForJob(args: {
  uid: string;
  instituteId?: string | null;
  jobId: string;
  status: ApplicationStatusKey;
  matchScore?: number;
  matchReasons?: string[];
  origin?: ApplicationDoc["origin"];
}) {
  const { uid, instituteId, jobId, status, matchScore, matchReasons, origin } = args;
  const id = `${uid}__${jobId}`;
  const ref = doc(db, "applications", id);
  const snap = await getDoc(ref);

  const base: Partial<ApplicationDoc> = {
    userId: uid,
    instituteId: instituteId ?? null,
    jobId,
    status,
    matchScore: matchScore ?? null,
    matchReasons: matchReasons ?? [],
    origin: origin ?? { type: "platform" },
    updatedAt: serverTimestamp() as unknown as Timestamp,
  };

  if (!snap.exists()) {
    await setDoc(
      ref,
      stripUndefinedDeep({
        ...base,
        createdAt: serverTimestamp(),
        appliedAt: status === "applied" ? serverTimestamp() : null,
      }),
      { merge: true }
    );
  } else {
    await updateDoc(
      ref,
      stripUndefinedDeep({
        ...base,
        appliedAt: status === "applied" ? serverTimestamp() : (snap.data() as ApplicationDoc).appliedAt ?? null,
      }) as any
    );
  }

  await addDoc(collection(db, "applications", id, "logs"), {
    action: "status_changed",
    to: status,
    at: serverTimestamp(),
    by: uid,
  });

  return id;
}

export async function updateApplicationStatus(appId: string, uid: string, status: ApplicationStatusKey) {
  await updateDoc(doc(db, "applications", appId), {
    status,
    updatedAt: serverTimestamp(),
    appliedAt: status === "applied" ? serverTimestamp() : null,
  } as any);
  await addDoc(collection(db, "applications", appId, "logs"), {
    action: "status_changed",
    to: status,
    at: serverTimestamp(),
    by: uid,
  });
}

export async function saveApplicationNotes(appId: string, uid: string, notes: string) {
  await updateDoc(doc(db, "applications", appId), { notes, updatedAt: serverTimestamp() } as any);
  await addDoc(collection(db, "applications", appId, "logs"), {
    action: "notes_updated",
    at: serverTimestamp(),
    by: uid,
  });
}

export async function addApplicationEvent(args: {
  applicationId: string;
  uid: string;
  type: EventDoc["type"];
  scheduledAt: Date;
  title?: string;
  link?: string;
  description?: string;
}) {
  const { applicationId, uid, type, scheduledAt, title, link, description } = args;
  await addDoc(collection(db, "applications", applicationId, "events"), {
    type,
    scheduledAt: Timestamp.fromDate(scheduledAt),
    title: title ?? null,
    link: link ?? null,
    description: description ?? null,
    createdBy: uid,
    createdAt: serverTimestamp(),
  });

  await updateDoc(doc(db, "applications", applicationId), {
    lastEventAt: Timestamp.fromDate(scheduledAt),
    updatedAt: serverTimestamp(),
  } as any);
}

export async function listUpcomingEvents(uid: string, take = 10) {
  const apps = await listApplications(uid);
  const nowMs = Date.now();
  const results: Array<{ applicationId: string; jobId: string; event: any }> = [];

  await Promise.all(
    apps.map(async ({ id, data }) => {
      const evQ = query(collection(db, "applications", id, "events"), limit(10));
      const snap = await getDocs(evQ);
      const upcoming = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as any) }))
        .filter((e) => e.scheduledAt?.toMillis?.() >= nowMs)
        .sort((a, b) => a.scheduledAt.toMillis() - b.scheduledAt.toMillis())[0];
      if (upcoming) results.push({ applicationId: id, jobId: jobIdFromAny(data.jobId), event: upcoming });
    })
  );

  return results
    .sort((a, b) => a.event.scheduledAt.toMillis() - b.event.scheduledAt.toMillis())
    .slice(0, take);
}

// ---------------------------
// Notifications
// ---------------------------

export async function listUserNotifications(uid: string, take = 50): Promise<Array<{ id: string; data: NotificationDoc }>> {
  const q = query(collection(db, "users", uid, "notifications"), limit(take));
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() as NotificationDoc }));
  return rows.sort((a, b) => tsMillis((b.data as any).createdAt) - tsMillis((a.data as any).createdAt));
}

export async function markNotificationRead(uid: string, notificationId: string) {
  await updateDoc(doc(db, "users", uid, "notifications", notificationId), { read: true } as any);
}

export async function markAllNotificationsRead(uid: string) {
  const q = query(collection(db, "users", uid, "notifications"), limit(200));
  const snap = await getDocs(q);
  if (snap.empty) return;
  const batch = writeBatch(db);
  snap.docs.forEach((d) => batch.update(d.ref, { read: true } as any));
  await batch.commit();
}

// ---------------------------
// Resume helpers
// ---------------------------

export async function createPrivateJobForUser(args: {
  uid: string;
  title: string;
  company: string;
  location?: string;
  jobType?: "Internship" | "Full-time";
  applyUrl?: string;
  jdText?: string;
  tags?: string[];
  source?: JobDoc["source"];
}) {
  const { uid, title, company, location, jobType, applyUrl, jdText, tags, source } = args;
  const ref = await addDoc(collection(db, "jobs"), {
    title,
    company,
    location: location ?? "",
    jobType: jobType ?? "Internship",
    applyUrl: applyUrl ?? "",
    jdText: jdText ?? "",
    tags: tags ?? [],
    source: source ?? "manual",
    visibility: "private",
    ownerUid: uid,
    instituteId: null,
    status: "open",
    postedAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } as any);
  return ref.id;
}

export async function exportUserData(uid: string) {
  const userSnap = await getDoc(doc(db, "users", uid));
  const profileSnap = await getDoc(doc(db, "users", uid, "master_profile", "main"));
  const apps = await listApplications(uid);
  return {
    user: userSnap.exists() ? userSnap.data() : null,
    master_profile: profileSnap.exists() ? profileSnap.data() : null,
    applications: apps.map((a) => ({ id: a.id, ...a.data })),
  };
}

export async function deleteUserData(uid: string) {
  await deleteDoc(doc(db, "users", uid, "master_profile", "main")).catch(() => {});
  const apps = await listApplications(uid);
  for (const a of apps) {
    await deleteDoc(doc(db, "applications", a.id)).catch(() => {});
  }
  await deleteDoc(doc(db, "users", uid)).catch(() => {});
}
