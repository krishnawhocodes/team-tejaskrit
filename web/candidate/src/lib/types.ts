import type { Timestamp } from "firebase/firestore";

export type UserRole = "student" | "tpo" | "admin";

export type JobSourceKey = "scraped" | "telegram" | "tpo" | "extension" | "manual";
export type JobVisibility = "public" | "institute" | "private";

export type ApplicationStatusKey =
  | "saved"
  | "tailored"
  | "applied"
  | "oa_scheduled"
  | "interview_scheduled"
  | "offer"
  | "rejected"
  | "joined"
  | "withdrawn";

export type EventTypeKey = "oa" | "interview" | "deadline" | "followup";

export interface UserDoc {
  uid: string;
  name?: string;
  email?: string;
  phone?: string;
  role?: UserRole;
  instituteId?: string | null;
  photoUrl?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  lastLoginAt?: Timestamp;
  onboardedAt?: Timestamp;
  prefs?: {
    locations?: string[];
    jobTypes?: Array<"Internship" | "Full-time">;
    domains?: string[];
  };

  // Optional privacy/consent flags (hackathon-safe; enforcement can be added via Cloud Functions later)
  consents?: {
    resumeGeneration?: boolean;
    jobMatching?: boolean;
    shareWithTpo?: boolean;
  };

  // If you implement account deletion via Cloud Functions later, you can set this.
  deleteRequestedAt?: Timestamp;
}

export interface MasterProfileDoc {
  headline?: string;
  summary?: string;
  links?: {
    linkedin?: string;
    github?: string;
    portfolio?: string;
  };
  skills?: string[];
  education?: Array<{
    institute: string;
    degree: string;
    branch?: string;
    startYear?: number;
    endYear?: number;
    cgpa?: number;
  }>;
  experience?: Array<{
    title: string;
    company: string;
    start?: string; // YYYY-MM
    end?: string; // YYYY-MM or "Present"
    bullets?: string[];
  }>;
  projects?: Array<{
    name: string;
    tech?: string[];
    bullets?: string[];
    link?: string;
  }>;
  achievements?: string[];
  masterText?: string;
  updatedAt?: Timestamp;
}

export interface JobDoc {
  title: string;
  company: string;
  location?: string;
  jobType?: "Internship" | "Full-time";
  applyUrl?: string;
  jdText?: string;
  tags?: string[];

  source: JobSourceKey;
  sourceMeta?: Record<string, unknown>;

  visibility: JobVisibility;
  instituteId?: string | null;
  ownerUid?: string | null;

  status?: "open" | "closed" | "unknown";
  postedAt?: Timestamp;
  lastSeenAt?: Timestamp;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface RecommendationDoc {
  jobId: string; // "jobs/{id}" or just id (support both)
  score: number;
  localScore?: number;
  aiScore?: number;
  finalScore?: number;
  reasons?: string[];
  localReasons?: string[];
  aiReasons?: string[];
  source?: string;
  model?: string;
  generationId?: string;
  profileHash?: string;
  jobHash?: string;
  computedAt?: Timestamp;
}

export interface RecommendationMetaDoc {
  status?: "idle" | "generating" | "ready" | "failed";
  generationId?: string;
  model?: string;
  recommendationCount?: number;
  shortlistedJobIds?: string[];
  startedAt?: Timestamp;
  generatedAt?: Timestamp;
  updatedAt?: Timestamp;
  error?: string;
}

export interface ApplicationDoc {
  userId: string;
  instituteId?: string | null;
  jobId: string; // "jobs/{id}" or id

  status: ApplicationStatusKey;

  matchScore?: number;
  matchReasons?: string[];

  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  appliedAt?: Timestamp | null;

  tailoredResume?: {
    // We store LaTeX directly in Firestore (no Firebase Storage needed).
    latex?: string;
    // Legacy/optional fields (safe to keep for future):
    pdfUrl?: string;
    latexDocPath?: string;
    generatedAt?: Timestamp;
    genId?: string;
  };

  lastEventAt?: Timestamp | null;
  notes?: string;
  contact?: { name?: string; email?: string };

  origin?: {
    type?: "platform" | "extension";
    pageUrl?: string;
    detectedAts?: string;
  };
}

export interface EventDoc {
  type: EventTypeKey;
  scheduledAt: Timestamp;
  title?: string;
  description?: string;
  link?: string;
  createdBy: string;
  createdAt?: Timestamp;
}

export interface NotificationDoc {
  type: "match" | "reminder" | "announcement" | "update";
  title: string;
  body: string;
  read: boolean;
  createdAt: Timestamp;
  related?: {
    applicationId?: string;
    jobId?: string;
    url?: string;
  };
}

export interface InstituteDoc {
  name: string;
  code?: string;
  domainsAllowed?: string[];
  // ✅ only institutes with configured TPO should be selectable by candidates
  hasTpo?: boolean;
  isConfigured?: boolean;
  tpoConfiguredAt?: Timestamp;
  isActive?: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}
