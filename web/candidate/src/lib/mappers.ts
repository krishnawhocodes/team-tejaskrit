import type { ApplicationStatusKey, JobDoc, JobSourceKey } from "./types";

export type JobSourceLabel =
  | "Career Page"
  | "Telegram"
  | "Institute Verified"
  | "Extension"
  | "Manual";


export function normalizeJobSourceKey(job: Partial<JobDoc> & { sources?: unknown; sourceMeta?: Record<string, unknown>; ownerUid?: string | null }): JobSourceKey {
  const direct = typeof job?.source === "string" ? job.source.toLowerCase().trim() : "";
  if (direct === "telegram") return "telegram";
  if (direct === "tpo") return "tpo";
  if (direct === "extension") return "extension";
  if (direct === "manual") return "manual";
  if (direct === "scraped") return "scraped";

  const sources = Array.isArray((job as any)?.sources)
    ? (job as any).sources.map((x: unknown) => String(x).toLowerCase())
    : [];
  if (sources.some((x: string) => x.includes("telegram"))) return "telegram";
  if (sources.some((x: string) => x.includes("extension"))) return "extension";
  if (sources.some((x: string) => x.includes("manual"))) return "manual";
  if (sources.some((x: string) => x.includes("tpo") || x.includes("institute"))) return "tpo";
  if (sources.length) return "scraped";

  const sourceMetaId = typeof (job as any)?.sourceMeta?.sourceId === "string"
    ? String((job as any).sourceMeta.sourceId).toLowerCase()
    : "";
  if (sourceMetaId.includes("telegram")) return "telegram";
  if (sourceMetaId.includes("extension")) return "extension";
  if (sourceMetaId.includes("tpo") || sourceMetaId.includes("institute")) return "tpo";

  if (job?.visibility === "private" || (job as any)?.ownerUid) return "manual";
  return "scraped";
}

export function sourceLabel(source: JobSourceKey, instituteVerified = false): JobSourceLabel {
  if (instituteVerified) return "Institute Verified";
  switch (source) {
    case "scraped":
      return "Career Page";
    case "telegram":
      return "Telegram";
    case "tpo":
      return "Institute Verified";
    case "extension":
      return "Extension";
    case "manual":
      return "Manual";
    default:
      return "Career Page";
  }
}

export type ApplicationStatusLabel =
  | "Saved"
  | "Tailored"
  | "Applied"
  | "OA Scheduled"
  | "Interview Scheduled"
  | "Offer"
  | "Joined"
  | "Rejected"
  | "Withdrawn";

export function statusLabel(status: ApplicationStatusKey): ApplicationStatusLabel {
  switch (status) {
    case "saved":
      return "Saved";
    case "tailored":
      return "Tailored";
    case "applied":
      return "Applied";
    case "oa_scheduled":
      return "OA Scheduled";
    case "interview_scheduled":
      return "Interview Scheduled";
    case "offer":
      return "Offer";
    case "joined":
      return "Joined";
    case "rejected":
      return "Rejected";
    case "withdrawn":
      return "Withdrawn";
  }
}

export const STATUS_COLUMNS: ApplicationStatusKey[] = [
  "saved",
  "tailored",
  "applied",
  "oa_scheduled",
  "interview_scheduled",
  "offer",
  "joined",
  "rejected",
  "withdrawn",
];
