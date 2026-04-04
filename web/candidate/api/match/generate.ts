import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAdminDb } from "../_lib/firebaseAdmin.js";
import { requireUser } from "../_lib/auth.js";
import { groqChatJson } from "../_lib/groq.js";
import { stripUndefinedDeep } from "../_lib/util.js";
import { buildCandidateText, computeLocalRecommendation, listVisibleJobsForUser } from "../_lib/recommendation.js";

type ResultRow = {
  jobId: string;
  localScore: number;
  aiScore?: number;
  finalScore: number;
  localReasons: string[];
  aiReasons: string[];
  reasons: string[];
};

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");

  try {
    const authed = await requireUser(req);
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
    const startedAt = new Date();
    const generationId = `${startedAt.getTime()}`;

    await metaRef.set(
      stripUndefinedDeep({
        status: "generating",
        generationId,
        startedAt,
        updatedAt: startedAt,
        model: "llama-3.1-8b-instant",
      }),
      { merge: true }
    );

    const visibleJobs = await listVisibleJobsForUser(db, {
      uid: authed.uid,
      instituteId: user?.instituteId ?? null,
      take: 150,
    });
    if (!visibleJobs.length) return bad(res, 404, "No visible jobs found");

    const localRanked = visibleJobs
      .map((row) => {
        const local = computeLocalRecommendation(row.data, user, profile);
        return { ...row, localScore: local.score, localReasons: local.reasons };
      })
      .sort((a, b) => b.localScore - a.localScore);

    const shortlist = localRanked.slice(0, 8);
    const candidateText = buildCandidateText(user, profile);
    const promptJobs = shortlist.map((row) => ({
      jobId: row.id,
      title: row.data.title ?? "",
      company: row.data.company ?? "",
      location: row.data.location ?? "",
      jobType: row.data.jobType ?? "",
      tags: Array.isArray(row.data.tags) ? row.data.tags.slice(0, 15) : [],
      jdText: String(row.data.jdText ?? "").slice(0, 1800),
      localScore: row.localScore,
      localReasons: row.localReasons,
    }));

    let aiRows: any[] = [];
    try {
      const out = await groqChatJson({
        model: "llama-3.1-8b-instant",
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
        maxTokens: 1300,
      });

      aiRows = Array.isArray(out?.results) ? out.results : [];
    } catch (groqError) {
      console.error("AI recommendation overlay failed; saving local recommendations only", groqError);
    }
    const aiByJobId = new Map<string, { score: number; reasons: string[] }>();
    for (const row of aiRows) {
      if (!row?.jobId) continue;
      aiByJobId.set(String(row.jobId), {
        score: clampScore(row.score),
        reasons: Array.isArray(row.reasons) ? row.reasons.map(String).slice(0, 4) : [],
      });
    }

    const completedAt = new Date();
    const results: ResultRow[] = localRanked.map((row) => {
      const ai = aiByJobId.get(row.id);
      const hasAi = !!ai;
      const aiScore = hasAi ? clampScore(ai?.score ?? row.localScore) : undefined;
      const finalScore = hasAi
        ? clampScore(row.localScore * 0.45 + (aiScore ?? row.localScore) * 0.55)
        : clampScore(row.localScore);
      return {
        jobId: row.id,
        localScore: row.localScore,
        aiScore,
        finalScore,
        localReasons: row.localReasons,
        aiReasons: ai?.reasons ?? [],
        reasons: Array.from(new Set([...(ai?.reasons ?? []), ...row.localReasons])).slice(0, 5),
      };
    });

    const jobMap = new Map(visibleJobs.map((row) => [row.id, row.data]));

    const batch = db.batch();
    for (const row of results) {
      const job = jobMap.get(row.jobId) ?? {};
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
          source: row.aiScore !== undefined ? "groq:manual-v2" : "local:manual-v1",
          model: "llama-3.1-8b-instant",
          generationId,
          computedAt: completedAt,
          profileHash: hashish(candidateText),
          jobHash: hashish(JSON.stringify({
            title: job?.title ?? "",
            company: job?.company ?? "",
            location: job?.location ?? "",
            jobType: job?.jobType ?? "",
            tags: job?.tags ?? [],
            jdText: String(job?.jdText ?? "").slice(0, 1200),
          })),
        }),
        { merge: true }
      );
    }

    batch.set(
      metaRef,
      stripUndefinedDeep({
        status: "ready",
        generationId,
        startedAt,
        generatedAt: completedAt,
        updatedAt: completedAt,
        model: "llama-3.1-8b-instant",
        recommendationCount: results.length,
        aiRecommendationCount: results.filter((x) => x.aiScore !== undefined).length,
        shortlistedJobIds: shortlist.map((x) => x.id),
      }),
      { merge: true }
    );

    await batch.commit();

    return res.status(200).json({
      ok: true,
      generationId,
      recommendationCount: results.length,
      aiRecommendationCount: results.filter((row) => row.aiScore !== undefined).length,
      results: results.map((row) => ({
        jobId: row.jobId,
        score: row.finalScore,
        reasons: row.reasons,
      })),
    });
  } catch (e: any) {
    try {
      const authed = await requireUser(req).catch(() => null);
      if (authed?.uid) {
        const db = getAdminDb();
        await db
          .collection("users")
          .doc(authed.uid)
          .collection("recommendation_meta")
          .doc("main")
          .set(
            stripUndefinedDeep({
              status: "failed",
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
