import { AppLayout } from "@/components/layout/AppLayout";
import { SourceBadge } from "@/components/SourceBadge";
import { MatchScore } from "@/components/MatchScore";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AiRecommendationButton } from "@/components/AiRecommendationButton";
import {
  Sparkles,
  Briefcase,
  CalendarDays,
  Trophy,
  ExternalLink,
  FileText,
  ArrowRight,
  Clock,
  CheckCircle2,
  Star,
  Video,
  Calendar,
} from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { useAuth } from "@/contexts/AuthProvider";
import { useQuery } from "@tanstack/react-query";
import {
  getActiveRecommendationBundle,
  jobIdFromAny,
  listApplications,
  listInstituteJobs,
  listJobsFeedForUser,
  listUpcomingEvents,
} from "@/lib/firestore";
import { generateTailoredLatex } from "@/lib/api";
import type { JobDoc, RecommendationBundleJob } from "@/lib/types";
import { sourceLabel } from "@/lib/mappers";
import { toast } from "@/hooks/use-toast";

const activityIcons: Record<string, React.ReactNode> = {
  file: <FileText className="h-4 w-4" />,
  check: <CheckCircle2 className="h-4 w-4" />,
  calendar: <Calendar className="h-4 w-4" />,
  star: <Star className="h-4 w-4" />,
  video: <Video className="h-4 w-4" />,
};

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.05, duration: 0.3 } }),
};

type JobUI = {
  id: string;
  title: string;
  company: string;
  location?: string;
  jobType?: "Internship" | "Full-time";
  applyUrl?: string;
  matchScore: number;
  matchReasons: string[];
  source: ReturnType<typeof sourceLabel>;
  lastSeen: string;
};

function timeAgo(dateMs?: number) {
  if (!dateMs) return "—";
  const diff = Date.now() - dateMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  return `${days} days ago`;
}

function bundleJobToUI(job: RecommendationBundleJob): JobUI {
  return {
    id: job.jobId,
    title: job.title,
    company: job.company,
    location: job.location,
    jobType: job.jobType as JobUI["jobType"],
    applyUrl: job.applyUrl,
    matchScore: job.matchScore,
    matchReasons: job.matchReasons?.length ? job.matchReasons : ["Saved AI recommendation"],
    source: sourceLabel((job.source as any) || "manual", job.visibility === "institute"),
    lastSeen: timeAgo(job.lastSeenAtMs),
  };
}

export default function Dashboard() {
  const { authUser, userDoc } = useAuth();

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const { data: activeRecommendationBundle, isLoading: recommendationLoading } = useQuery({
    queryKey: ["activeRecommendationBundle", authUser?.uid],
    enabled: !!authUser?.uid,
    queryFn: () => getActiveRecommendationBundle(authUser!.uid),
    staleTime: 30_000,
  });

  const savedBundleJobs = activeRecommendationBundle?.bundle?.jobs ?? [];
  const hasSavedBundle = savedBundleJobs.length > 0;

  const recJobs = useMemo(() => savedBundleJobs.slice(0, 6).map((job) => bundleJobToUI(job)), [savedBundleJobs]);

  const { data: fallbackJobs, isLoading: fallbackLoading } = useQuery({
    queryKey: ["homeFallbackJobs", authUser?.uid, userDoc?.instituteId],
    enabled: !!authUser?.uid && !recommendationLoading && !hasSavedBundle,
    queryFn: async () => {
      if (!authUser?.uid) return [] as JobUI[];
      const rows = await listJobsFeedForUser({
        uid: authUser.uid,
        instituteId: userDoc?.instituteId ?? null,
        take: 12,
      });
      return rows.map((r) => toJobUI(r.id, r.data, 0, ["Generate AI Tejaskrit recommendation to rank these jobs."], r.data.visibility === "institute"));
    },
    staleTime: 20_000,
  });

  const { data: instituteJobsFallback } = useQuery({
    queryKey: ["instituteJobs", userDoc?.instituteId],
    enabled: !!userDoc?.instituteId && !hasSavedBundle,
    queryFn: async () => {
      const jobs = await listInstituteJobs(userDoc!.instituteId!, 6);
      return jobs.map((j) => toJobUI(j.id, j.data, 0, ["AI recommendation will appear here after generation."], true));
    },
    staleTime: 30_000,
  });

  const { data: apps } = useQuery({
    queryKey: ["applications", authUser?.uid],
    enabled: !!authUser?.uid,
    queryFn: () => listApplications(authUser!.uid),
    staleTime: 15_000,
  });

  const { data: upcoming } = useQuery({
    queryKey: ["upcomingEvents", authUser?.uid],
    enabled: !!authUser?.uid,
    queryFn: () => listUpcomingEvents(authUser!.uid, 4),
    staleTime: 15_000,
  });

  const prioritySource = hasSavedBundle ? recJobs : (fallbackJobs ?? []);
  const priorityJobs = prioritySource.slice(0, 6);

  const instituteJobs = useMemo(
    () => (hasSavedBundle ? savedBundleJobs.filter((job) => job.visibility === "institute").slice(0, 6).map((job) => bundleJobToUI(job)) : instituteJobsFallback ?? []),
    [hasSavedBundle, savedBundleJobs, instituteJobsFallback]
  );

  const kpis = computeKPIs(prioritySource, apps ?? [], upcoming ?? []);

  const recentActivity = (apps ?? [])
    .slice(0, 5)
    .map((a) => ({
      id: a.id,
      text: `Updated: ${String(a.data.status).replace(/_/g, " ")} — ${jobIdFromAny(a.data.jobId)}`,
      time: a.data.updatedAt ? timeAgo((a.data.updatedAt as any).toMillis?.()) : "—",
      icon: a.data.status === "tailored" ? "file" : a.data.status === "applied" ? "check" : "calendar",
    }));

  const onGenerateResumeQuick = async (job: JobUI) => {
    if (!authUser?.uid) return;
    try {
      await generateTailoredLatex({ jobId: job.id, matchScore: job.matchScore, matchReasons: job.matchReasons });
      toast({ title: "Tailored resume generated", description: "LaTeX saved. Download from Resume → Tailored." });
    } catch (e: any) {
      toast({ title: "Failed", description: e?.message ?? "Could not request resume.", variant: "destructive" });
    }
  };

  return (
    <AppLayout>
      <div className="page-container space-y-8">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <h1 className="text-2xl font-bold">
            {greeting}, {(userDoc?.name || authUser?.displayName || "").split(" ")[0] || ""}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Your placement journey at a glance</p>
        </motion.div>

        <AiRecommendationButton
          hasRecommendations={hasSavedBundle}
          generatedAtLabel={activeRecommendationBundle?.meta?.generatedAt ? timeAgo((activeRecommendationBundle.meta.generatedAt as any)?.toMillis?.()) : undefined}
        />

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {kpis.map((kpi, i) => (
            <motion.div key={kpi.label} custom={i} initial="hidden" animate="visible" variants={fadeUp}>
              <Card className="card-elevated p-5 flex items-start gap-4">
                <div className={`h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0 ${kpi.color}`}>
                  <kpi.icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{kpi.value}</p>
                  <p className="text-xs text-muted-foreground">{kpi.label}</p>
                </div>
              </Card>
            </motion.div>
          ))}
        </div>

  

        {/* Priority Opportunities */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Priority Opportunities</h2>
            <Link to="/jobs">
              <Button variant="ghost" size="sm" className="text-xs gap-1">
                View All <ArrowRight className="h-3 w-3" />
              </Button>
            </Link>
          </div>

          {recommendationLoading || (!hasSavedBundle && fallbackLoading) ? (
            <Card className="card-elevated p-6 text-sm text-muted-foreground">Loading priority jobs…</Card>
          ) : priorityJobs.length === 0 ? (
            <Card className="card-elevated p-6 text-sm text-muted-foreground">
              Generate AI Tejaskrit recommendations to save your top matched jobs here.
            </Card>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {priorityJobs.map((job, i) => (
                <motion.div key={job.id} custom={i} initial="hidden" animate="visible" variants={fadeUp}>
                  <Card className="card-elevated p-5 flex flex-col gap-3 h-full">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="font-semibold text-sm truncate">{job.title}</h3>
                        <p className="text-xs text-muted-foreground">
                          {job.company} · {job.location ?? "—"}
                        </p>
                      </div>
                      <MatchScore score={job.matchScore} size="lg" />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <SourceBadge source={job.source} />
                      {job.matchReasons.slice(0, 2).map((r) => (
                        <span key={r} className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                          {r}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {job.lastSeen}
                    </p>
                    <div className="flex gap-2 mt-auto pt-2">
                      <Link to="/jobs" className="flex-1">
                        <Button size="sm" variant="outline" className="text-xs w-full">
                          View
                        </Button>
                      </Link>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs flex-1 gap-1"
                        onClick={() => onGenerateResumeQuick(job)}
                      >
                        <FileText className="h-3 w-3" /> Resume
                      </Button>
                      <Button
                        size="sm"
                        className="text-xs flex-1 gap-1"
                        onClick={() => job.applyUrl && window.open(job.applyUrl, "_blank")}
                      >
                        <ExternalLink className="h-3 w-3" /> Apply
                      </Button>
                    </div>
                  </Card>
                </motion.div>
              ))}
            </div>
          )}
        </section>

        {/* Institute Verified */}
        {(instituteJobs?.length ?? 0) > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-4">Institute Verified Drives</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {instituteJobs!.map((job) => (
                <Card key={job.id} className="card-elevated p-5 border-l-4 border-l-primary space-y-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold text-sm">{job.title}</h3>
                      <p className="text-xs text-muted-foreground">
                        {job.company} · {job.location ?? "—"}
                      </p>
                    </div>
                    <MatchScore score={job.matchScore} />
                  </div>
                  <SourceBadge source="Institute Verified" />
                  <Button size="sm" className="text-xs w-full mt-2" onClick={() => job.applyUrl && window.open(job.applyUrl, "_blank")}>
                    View & Apply
                  </Button>
                </Card>
              ))}
            </div>
          </section>
        )}

        {/* Bottom Grid: Upcoming + Activity */}
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Upcoming Timeline */}
          <section>
            <h2 className="text-lg font-semibold mb-4">Upcoming Events</h2>
            <Card className="card-elevated divide-y divide-border">
              {(upcoming ?? []).length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No upcoming OA/Interview events yet.</div>
              ) : (
                (upcoming ?? []).map((x) => (
                  <div key={x.applicationId} className="p-4 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-9 w-9 rounded-lg bg-accent flex items-center justify-center shrink-0">
                        <CalendarDays className="h-4 w-4 text-accent-foreground" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {x.event.title || x.event.type?.toUpperCase()} — {x.jobId}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(x.event.scheduledAt.toMillis()).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <Link to="/tracker">
                      <Button variant="ghost" size="sm" className="text-xs shrink-0">
                        Open
                      </Button>
                    </Link>
                  </div>
                ))
              )}
            </Card>
          </section>

          {/* Recent Activity */}
          <section>
            <h2 className="text-lg font-semibold mb-4">Recent Activity</h2>
            <Card className="card-elevated divide-y divide-border">
              {recentActivity.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No activity yet.</div>
              ) : (
                recentActivity.map((item) => (
                  <div key={item.id} className="p-4 flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0 text-muted-foreground">
                      {activityIcons[item.icon] || <CheckCircle2 className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{item.text}</p>
                      <p className="text-xs text-muted-foreground">{item.time}</p>
                    </div>
                  </div>
                ))
              )}
            </Card>
          </section>
        </div>
      </div>
    </AppLayout>
  );
}

function toJobUI(id: string, j: JobDoc, score: number, reasons: string[], instituteVerified = false): JobUI {
  const lastSeenMs = (j.lastSeenAt as any)?.toMillis?.() ?? (j.postedAt as any)?.toMillis?.();
  return {
    id,
    title: j.title,
    company: j.company,
    location: j.location,
    jobType: j.jobType,
    applyUrl: j.applyUrl,
    matchScore: score,
    matchReasons: reasons,
    source: sourceLabel(j.source, instituteVerified || j.visibility === "institute"),
    lastSeen: timeAgo(lastSeenMs),
  };
}

function computeKPIs(jobs: JobUI[], apps: Array<{ id: string; data: any }>, upcoming: any[]) {
  const offers = apps.filter((a) => a.data.status === "offer").length;
  const active = apps.filter((a) => ["applied", "oa_scheduled", "interview_scheduled"].includes(a.data.status)).length;
  return [
    { label: "New Matches", value: String(Math.min(jobs.length, 9)), icon: Sparkles, color: "text-primary" },
    { label: "Active Applications", value: String(active), icon: Briefcase, color: "text-info" },
    { label: "Upcoming Events", value: String(upcoming.length), icon: CalendarDays, color: "text-warning" },
    { label: "Offers", value: String(offers), icon: Trophy, color: "text-success" },
  ];
}
