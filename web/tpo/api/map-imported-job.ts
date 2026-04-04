import { requireUser } from "./_lib/auth.js";
import { groqJson } from "./_lib/groq.js";

const BRANCHES = ["CSE", "IT", "ECE", "EE", "ME", "CE"];
const BATCHES = ["2024", "2025", "2026", "2027"];

function bad(res: any, status: number, msg: string) {
  return res.status(status).json({ ok: false, error: msg });
}

function formatDateTimeLocal(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function normalizeDateTimeLocal(v: any, fallbackTime = "23:59") {
  if (!v) return "";

  const s = String(v).trim();
  if (!s) return "";

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T${fallbackTime}`;

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return formatDateTimeLocal(d);

  return "";
}

function normalizeMapped(out: any) {
  const jobTypeRaw = String(out?.jobType || "").trim();
  const jobType =
    jobTypeRaw === "Internship" || jobTypeRaw === "Full-time" ? jobTypeRaw : "";

  const eligibleBranches = Array.isArray(out?.eligibleBranches)
    ? out.eligibleBranches
        .map((x: any) => String(x).trim().toUpperCase())
        .filter((x: string) => BRANCHES.includes(x))
    : [];

  const batch = BATCHES.includes(String(out?.batch || "").trim())
    ? String(out.batch).trim()
    : "";

  return {
    title: String(out?.title || "").trim(),
    company: String(out?.company || "").trim(),
    location: String(out?.location || "").trim(),
    jobType,
    ctcOrStipend: String(out?.ctcOrStipend || "").trim(),
    applyUrl: String(out?.applyUrl || "").trim(),
    jdText: String(out?.jdText || "").trim(),
    eligibleBranches,
    batch,
    minCgpa:
      out?.minCgpa === null || out?.minCgpa === undefined
        ? ""
        : String(out.minCgpa).trim(),
    skillsCsv: String(out?.skillsCsv || "").trim(),
    seatLimit:
      out?.seatLimit === null || out?.seatLimit === undefined
        ? ""
        : String(out.seatLimit).trim(),
    deadlineLocal: normalizeDateTimeLocal(out?.deadlineLocal, "23:59"),
    oaLocal: normalizeDateTimeLocal(out?.oaLocal, "09:00"),
    interviewStart: normalizeDateTimeLocal(out?.interviewStart, "09:00"),
    interviewEnd: normalizeDateTimeLocal(out?.interviewEnd, "18:00"),
    missingFields: Array.isArray(out?.missingFields)
      ? out.missingFields.map((x: any) => String(x))
      : [],
    confidence:
      out?.confidence && typeof out.confidence === "object"
        ? out.confidence
        : {},
  };
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");

  try {
    await requireUser(req);

    const rawPdfJson = req.body?.rawPdfJson;
    if (!rawPdfJson || typeof rawPdfJson !== "object") {
      return bad(res, 400, "rawPdfJson is required");
    }

    const out = await groqJson([
      {
        role: "system",
        content:
          "You are extracting TPO job drive data from a client-generated PDF JSON. " +
          "Return strict JSON only. Never invent values. " +
          "If uncertain, return empty string or empty array.",
      },
      {
        role: "user",
        content: `
Map the following raw PDF JSON into the exact TPO Create New Drive form.

Rules:
- Only use data present in the JSON.
- jobType must be exactly one of: "", "Internship", "Full-time".
- eligibleBranches must only contain values from: ${BRANCHES.join(", ")}.
- batch must be exactly one of: "", ${BATCHES.join(", ")}.
- minCgpa and seatLimit must be strings.
- skillsCsv must be a comma-separated string.
- deadlineLocal, oaLocal, interviewStart, interviewEnd must be "YYYY-MM-DDTHH:mm" or "".
- jdText should be readable extracted job description text from the PDF JSON, not a made-up summary.
- Include missingFields as array.
- Include confidence values from 0 to 1.

Return JSON exactly in this shape:
{
  "title": "",
  "company": "",
  "location": "",
  "jobType": "",
  "ctcOrStipend": "",
  "applyUrl": "",
  "jdText": "",
  "eligibleBranches": [],
  "batch": "",
  "minCgpa": "",
  "skillsCsv": "",
  "seatLimit": "",
  "deadlineLocal": "",
  "oaLocal": "",
  "interviewStart": "",
  "interviewEnd": "",
  "missingFields": [],
  "confidence": {
    "title": 0,
    "company": 0,
    "location": 0,
    "jobType": 0,
    "ctcOrStipend": 0,
    "applyUrl": 0,
    "jdText": 0,
    "eligibleBranches": 0,
    "batch": 0,
    "minCgpa": 0,
    "skillsCsv": 0,
    "seatLimit": 0,
    "deadlineLocal": 0,
    "oaLocal": 0,
    "interviewStart": 0,
    "interviewEnd": 0
  }
}

RAW PDF JSON:
${JSON.stringify(rawPdfJson)}
        `,
      },
    ]);

    const mapped = normalizeMapped(out);

    return res.status(200).json({
      ok: true,
      mapped,
    });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
    });
  }
}
