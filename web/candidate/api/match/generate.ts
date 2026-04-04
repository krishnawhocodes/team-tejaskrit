import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { requireUser } from "../_lib/auth.js";
import { groqChatJson } from "../_lib/groq.js";
import { stripUndefinedDeep } from "../_lib/util.js";
import {
  buildBundleJobSnapshot,
  buildCandidateText,
  chunkArray,
  computeLocalRecommendation,
  jobSortKey,
  listVisibleJobsForUser,
} from "../_lib/recommendation.js";

type ResultRow = {
  jobId: string;
  localScore: number;
  aiScore?: number;
  finalScore: number;
  localReasons: string[];
  aiReasons: string[];
  reasons: string[];
  job: any;
};

const MODEL = process.env.GROQ_RECOMMENDATION_MODEL || "llama-3.1-8b-instant";
const AI_CHUNK_SIZE = Math.max(5, Math.min(Number(process.env.GROQ_RECOMMENDATION_CHUNK_SIZE || 20), 25));
const MAX_VISIBLE_JOBS = Math.max(20, Math.min(Number(process.env.GROQ_RECOMMENDATION_MAX_JOBS || 150), 150));

function bad(res: VercelResponse, status: number, msg: string) {
  return res.status(status).json({ ok: false, error: msg });
}

function clampScore(n: number) {
  return Math.max(0, Math.min(100, Math.round(Number(n || 0))));
}

function hashish(input: string) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `h${(h >>> 0).toString(16)}`;
}

async function updateMeta(metaRef: any, patch: Record<string, unknown>) {
  await metaRef.set(stripUndefinedDeep({ ...patch, updatedAt: new Date() }), { merge: true });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");

  let authed: Awaited<ReturnType<typeof requireUser>> | null = null;
  let previousActiveGenerationId: string | undefined;

  try {
    authed = await requireUser(req);
    const db = getAdminDb();

    const userRef = db.collection("users").doc(authed.uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return bad(res, 404, "User not found");
    const user = userSnap.data() || {};

    if (user?.consents?.jobMatching === false) return bad(res, 403, "Job matching disabled");

    const profileSnap = await userRef.collection("master_profile").doc("main").get();
    if (!profileSnap.exists) return bad(res, 400, "Master profile missing");
    const profile = profileSnap.data() || {};

    const metaRef = userRef.collection("recommendation_meta").doc("main");
    const existingMetaSnap = await metaRef.get();
    const existingMeta = existingMetaSnap.exists ? existingMetaSnap.data() || {} : {};
    previousActiveGenerationId = typeof existingMeta?.activeGenerationId === "string"
      ? existingMeta.activeGenerationId
      : typeof existingMeta?.generationId === "string"
      ? existingMeta.generationId
      : undefined;

    const startedAt = new Date();
    const generationId = `${startedAt.getTime()}`;
    const generationRef = userRef.collection("recommendation_generations").doc(generationId);

    await updateMeta(metaRef, {
      status: "generating",
      stage: "loading_jobs",
      progressPercent: 6,
      generationId,
      activeGenerationId: previousActiveGenerationId ?? null,
      startedAt,
      model: MODEL,
      error: null,
      chunksDone: 0,
      totalChunks: 0,
    });

    const visibleJobs = await listVisibleJobsForUser(db, {
      uid: authed.uid,
      instituteId: user?.instituteId ?? null,
      take: MAX_VISIBLE_JOBS,
    });
    if (!visibleJobs.length) {
      await updateMeta(metaRef, {
        status: previousActiveGenerationId ? "ready" : "idle",
        stage: previousActiveGenerationId ? "ready" : "idle",
        progressPercent: previousActiveGenerationId ? 100 : 0,
        error: "No visible jobs found",
      });
      return bad(res, 404, "No visible jobs found");
    }

    await generationRef.set(
      stripUndefinedDeep({
        generationId,
        status: "generating",
        startedAt,
        updatedAt: startedAt,
        model: MODEL,
        recommendationCount: visibleJobs.length,
        jobs: [],
      }),
      { merge: true }
    );

    await updateMeta(metaRef, {
      stage: "local_scoring",
      progressPercent: 16,
      visibleJobCount: visibleJobs.length,
    });

    const localRanked = visibleJobs
      .map((row) => {
        const local = computeLocalRecommendation(row.data, user, profile);
        return { ...row, localScore: local.score, localReasons: local.reasons };
      })
      .sort((a, b) => b.localScore - a.localScore || jobSortKey(b.data) - jobSortKey(a.data));

    const candidateText = buildCandidateText(user, profile);
    const profileHash = hashish(candidateText);
    const jobChunks = chunkArray(localRanked, AI_CHUNK_SIZE);

    await updateMeta(metaRef, {
      stage: "ai_scoring",
      progressPercent: jobChunks.length ? 24 : 80,
      chunksDone: 0,
      totalChunks: jobChunks.length,
    });

    const aiByJobId = new Map<string, { score: number; reasons: string[] }>();

    for (let index = 0; index < jobChunks.length; index += 1) {
      const chunk = jobChunks[index]!;
      const promptJobs = chunk.map((row) => ({
        jobId: row.id,
        title: row.data.title ?? "",
        company: row.data.company ?? "",
        location: row.data.location ?? "",
        jobType: row.data.jobType ?? "",
        tags: Array.isArray(row.data.tags) ? row.data.tags.slice(0, 15) : [],
        jdText: String(row.data.jdText ?? "").slice(0, 900),
        localScore: row.localScore,
        localReasons: row.localReasons,
      }));

      try {
        const out = await groqChatJson({
          model: MODEL,
          messages: [
            {
              role: "system",
              content:
                "You are Tejaskrit AI job matcher. Score fit between a candidate master resume and jobs. Return STRICT JSON only. Scores are relevance percentages from 0 to 100. Keep reasons short, concrete, and resume-grounded. Do not invent experience.",
            },
            {
              role: "user",
              content: `Candidate:
${candidateText}

Jobs(JSON):
${JSON.stringify(promptJobs, null, 2)}

Return JSON exactly like {"results":[{"jobId":"...","score":82,"reasons":["...","...","..."]}]}`,
            },
          ],
          temperature: 0.1,
          maxTokens: 1800,
        });

        const aiRows = Array.isArray(out?.results) ? out.results : [];
        for (const row of aiRows) {
          if (!row?.jobId) continue;
          aiByJobId.set(String(row.jobId), {
            score: clampScore(row.score),
            reasons: Array.isArray(row.reasons) ? row.reasons.map((x: unknown) => String(x)).slice(0, 4) : [],
          });
        }
      } catch (groqError) {
        console.error(`AI recommendation chunk ${index + 1}/${jobChunks.length} failed; using local scores for this chunk`, groqError);
      }

      await updateMeta(metaRef, {
        stage: "ai_scoring",
        progressPercent: clampScore(24 + ((index + 1) / Math.max(jobChunks.length, 1)) * 60),
        chunksDone: index + 1,
        totalChunks: jobChunks.length,
      });
    }

    const completedAt = new Date();
    const results: ResultRow[] = localRanked
      .map((row) => {
        const ai = aiByJobId.get(row.id);
        const hasAi = !!ai;
        const aiScore = hasAi ? clampScore(ai?.score ?? row.localScore) : undefined;
        const finalScore = hasAi
          ? clampScore(row.localScore * 0.4 + (aiScore ?? row.localScore) * 0.6)
          : clampScore(row.localScore);
        return {
          jobId: row.id,
          localScore: row.localScore,
          aiScore,
          finalScore,
          localReasons: row.localReasons,
          aiReasons: ai?.reasons ?? [],
          reasons: Array.from(new Set([...(ai?.reasons ?? []), ...row.localReasons])).slice(0, 5),
          job: row.data,
        };
      })
      .sort((a, b) => b.finalScore - a.finalScore || b.localScore - a.localScore || jobSortKey(b.job) - jobSortKey(a.job));

    const bundleJobs = results.map((row) =>
      buildBundleJobSnapshot({
        jobId: row.jobId,
        job: row.job,
        finalScore: row.finalScore,
        localScore: row.localScore,
        aiScore: row.aiScore,
        reasons: row.reasons,
      })
    );

    await updateMeta(metaRef, {
      stage: "saving",
      progressPercent: 94,
      chunksDone: jobChunks.length,
      totalChunks: jobChunks.length,
    });

    const batch = db.batch();
    for (const row of results) {
      const recRef = userRef.collection("recommendations").doc(row.jobId);
      batch.set(
        recRef,
        stripUndefinedDeep({
          jobId: row.jobId,
          score: row.finalScore,
          localScore: row.localScore,
          aiScore: row.aiScore,
          finalScore: row.finalScore,
          reasons: row.reasons,
          localReasons: row.localReasons,
          aiReasons: row.aiReasons,
          source: row.aiScore !== undefined ? "groq:manual-v3" : "local:manual-v2",
          model: MODEL,
          generationId,
          computedAt: completedAt,
          profileHash,
          jobHash: hashish(
            JSON.stringify({
              title: row.job?.title ?? "",
              company: row.job?.company ?? "",
              location: row.job?.location ?? "",
              jobType: row.job?.jobType ?? "",
              tags: row.job?.tags ?? [],
              jdText: String(row.job?.jdText ?? "").slice(0, 1200),
            })
          ),
        }),
        { merge: true }
      );
    }

    batch.set(
      generationRef,
      stripUndefinedDeep({
        generationId,
        status: "ready",
        startedAt,
        generatedAt: completedAt,
        updatedAt: completedAt,
        model: MODEL,
        recommendationCount: bundleJobs.length,
        aiRecommendationCount: results.filter((x) => x.aiScore !== undefined).length,
        jobs: bundleJobs,
        topJobsPreview: bundleJobs.slice(0, 12),
      }),
      { merge: true }
    );

    batch.set(
      metaRef,
      stripUndefinedDeep({
        status: "ready",
        stage: "ready",
        progressPercent: 100,
        generationId,
        activeGenerationId: generationId,
        startedAt,
        generatedAt: completedAt,
        updatedAt: completedAt,
        model: MODEL,
        recommendationCount: bundleJobs.length,
        aiRecommendationCount: results.filter((x) => x.aiScore !== undefined).length,
        visibleJobCount: visibleJobs.length,
        chunksDone: jobChunks.length,
        totalChunks: jobChunks.length,
        error: null,
      }),
      { merge: true }
    );

    await batch.commit();

    return res.status(200).json({
      ok: true,
      generationId,
      recommendationCount: bundleJobs.length,
      aiRecommendationCount: results.filter((row) => row.aiScore !== undefined).length,
      results: bundleJobs.slice(0, 20).map((row) => ({
        jobId: row.jobId,
        score: row.matchScore,
        reasons: row.matchReasons,
      })),
    });
  } catch (e: any) {
    try {
      if (authed?.uid) {
        const db = getAdminDb();
        await db
          .collection("users")
          .doc(authed.uid)
          .collection("recommendation_meta")
          .doc("main")
          .set(
            stripUndefinedDeep({
              status: previousActiveGenerationId ? "ready" : "failed",
              activeGenerationId: previousActiveGenerationId ?? null,
              stage: previousActiveGenerationId ? "ready" : "failed",
              progressPercent: previousActiveGenerationId ? 100 : 0,
              error: e?.message ?? "Unknown error",
              updatedAt: new Date(),
            }),
            { merge: true }
          );
      }
    } catch {}
    return res.status(500).json({ ok: false, error: e?.message ?? "Unknown error" });
  }
}
