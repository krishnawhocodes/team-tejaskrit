import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import {
  Briefcase,
  CalendarDays,
  Target,
  Trophy,
  TrendingUp,
  Building2,
  ArrowRight,
} from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import { useAuth } from "@/contexts/AuthProvider";
import {
  getJobsByIds,
  jobIdFromAny,
  listApplications,
  listUpcomingEvents,
} from "@/lib/firestore";
import { normalizeJobSourceKey, sourceLabel, statusLabel } from "@/lib/mappers";
import type { ApplicationStatusKey, JobDoc } from "@/lib/types";

const PIE_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--accent-foreground))",
  "hsl(var(--muted-foreground))",
  "hsl(var(--ring))",
  "hsl(var(--secondary-foreground))",
  "#7c3aed",
  "#0ea5e9",
  "#f59e0b",
  "#22c55e",
];

function msAny(ts: any) {
  try {
    if (!ts) return 0;
    if (typeof ts?.toMillis === "function") return ts.toMillis();
    if (typeof ts?.toDate === "function") return ts.toDate().getTime();
    if (ts instanceof Date) return ts.getTime();
    return 0;
  } catch {
    return 0;
  }
}

function monthKey(ms: number) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthLabel(key: string) {
  const [y, m] = key.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
}

function statusStageLabel(status: ApplicationStatusKey) {
  return statusLabel(status);
}

function relevantMs(app: any) {
  return msAny(app.appliedAt) || msAny(app.updatedAt) || msAny(app.createdAt);
}

export default function Analytics() {
  const { authUser } = useAuth();

  const { data: appRows, isLoading: appsLoading } = useQuery({
    queryKey: ["candidateAnalyticsApplications", authUser?.uid],
    enabled: !!authUser?.uid,
    queryFn: () => listApplications(authUser!.uid),
    staleTime: 15_000,
  });

  const { data: jobMap, isLoading: jobsLoading } = useQuery({
    queryKey: [
      "candidateAnalyticsJobs",
      authUser?.uid,
      (appRows ?? []).map((a) => a.data.jobId).join(","),
    ],
    enabled: !!authUser?.uid && (appRows?.length ?? 0) > 0,
    queryFn: async () => {
      const ids = (appRows ?? []).map((a) => jobIdFromAny(a.data.jobId));
      return await getJobsByIds(ids);
    },
    staleTime: 30_000,
  });

  const { data: upcoming } = useQuery({
    queryKey: ["candidateAnalyticsUpcoming", authUser?.uid],
    enabled: !!authUser?.uid,
    queryFn: () => listUpcomingEvents(authUser!.uid, 10),
    staleTime: 15_000,
  });

  const joinedApps = useMemo(() => {
    const rows = appRows ?? [];
    const jobs = jobMap ?? {};

    return rows.map((r) => {
      const jobId = jobIdFromAny(r.data.jobId);
      const job = jobs[jobId] as JobDoc | undefined;
      const status = r.data.status;
      const source = sourceLabel(
        normalizeJobSourceKey(job ?? {}),
        job?.visibility === "institute",
      );

      return {
        id: r.id,
        status,
        statusLabel: statusStageLabel(status),
        company: job?.company || "(Company)",
        title: job?.title || "(Role)",
        jobType: job?.jobType || "Unknown",
        source,
        instituteVerified: job?.visibility === "institute",
        ms: relevantMs(r.data),
      };
    });
  }, [appRows, jobMap]);

  const totalTracked = joinedApps.length;
  const activePipeline = joinedApps.filter((a) =>
    ["applied", "oa_scheduled", "interview_scheduled"].includes(a.status),
  ).length;
  const offers = joinedApps.filter((a) => a.status === "offer").length;
  const joinedCount = joinedApps.filter((a) => a.status === "joined").length;
  const totalSubmitted = joinedApps.filter(
    (a) => !["saved", "tailored"].includes(a.status),
  ).length;
  const responseCount = joinedApps.filter((a) =>
    [
      "oa_scheduled",
      "interview_scheduled",
      "offer",
      "joined",
      "rejected",
    ].includes(a.status),
  ).length;
  const responseRate =
    totalSubmitted > 0 ? Math.round((responseCount / totalSubmitted) * 100) : 0;
  const instituteVerifiedCount = joinedApps.filter(
    (a) => a.instituteVerified,
  ).length;

  const statusPie = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of joinedApps) {
      counts.set(a.statusLabel, (counts.get(a.statusLabel) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([name, value]) => ({
      name,
      value,
    }));
  }, [joinedApps]);

  const sourcePie = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of joinedApps) {
      counts.set(a.source, (counts.get(a.source) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([name, value]) => ({
      name,
      value,
    }));
  }, [joinedApps]);

  const jobTypePie = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of joinedApps) {
      const type = a.jobType || "Unknown";
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([name, value]) => ({
      name,
      value,
    }));
  }, [joinedApps]);

  const monthlyTrend = useMemo(() => {
    const counts = new Map<string, number>();
    const now = new Date();
    const keys: string[] = [];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      keys.push(key);
      counts.set(key, 0);
    }

    for (const a of joinedApps) {
      if (!a.ms) continue;
      const key = monthKey(a.ms);
      if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return keys.map((key) => ({
      month: monthLabel(key),
      applications: counts.get(key) ?? 0,
    }));
  }, [joinedApps]);

  const topCompanies = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of joinedApps) {
      counts.set(a.company, (counts.get(a.company) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([company, applications]) => ({ company, applications }))
      .sort((a, b) => b.applications - a.applications)
      .slice(0, 6);
  }, [joinedApps]);

  const funnelData = useMemo(() => {
    const stages: Array<{
      label: string;
      match: (s: ApplicationStatusKey) => boolean;
    }> = [
      { label: "Saved", match: (s) => s === "saved" },
      { label: "Tailored", match: (s) => s === "tailored" },
      { label: "Applied", match: (s) => s === "applied" },
      { label: "OA", match: (s) => s === "oa_scheduled" },
      { label: "Interview", match: (s) => s === "interview_scheduled" },
      { label: "Offer", match: (s) => s === "offer" },
      { label: "Joined", match: (s) => s === "joined" },
      {
        label: "Rejected",
        match: (s) => s === "rejected" || s === "withdrawn",
      },
    ];

    return stages.map((stage) => ({
      stage: stage.label,
      count: joinedApps.filter((a) => stage.match(a.status)).length,
    }));
  }, [joinedApps]);

  const topSource =
    sourcePie.slice().sort((a, b) => b.value - a.value)[0]?.name ?? "—";
  const topCompany = topCompanies[0]?.company ?? "—";
  const interviewRate =
    totalSubmitted > 0
      ? Math.round(
          (joinedApps.filter((a) => a.status === "interview_scheduled").length /
            totalSubmitted) *
            100,
        )
      : 0;
  const offerRate =
    totalSubmitted > 0
      ? Math.round(((offers + joinedCount) / totalSubmitted) * 100)
      : 0;

  const loading = appsLoading || jobsLoading;

  return (
    <AppLayout>
      <div className="page-container space-y-8">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">My Analytics</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Personal application insights across institute drives, public
              jobs, extension captures, and manual entries
            </p>
          </div>

          <div className="flex gap-2">
            <Link to="/tracker">
              <Button variant="outline" size="sm">
                Open Tracker
              </Button>
            </Link>
            <Link to="/jobs">
              <Button size="sm" className="gap-1">
                Explore Jobs <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          <MetricCard
            label="Tracked"
            value={String(totalTracked)}
            icon={Briefcase}
          />
          <MetricCard
            label="Active Pipeline"
            value={String(activePipeline)}
            icon={Target}
          />
          <MetricCard label="Offers" value={String(offers)} icon={Trophy} />
          <MetricCard
            label="Joined"
            value={String(joinedCount)}
            icon={TrendingUp}
          />
          <MetricCard
            label="Upcoming Events"
            value={String(upcoming?.length ?? 0)}
            icon={CalendarDays}
          />
          <MetricCard
            label="Response Rate"
            value={`${responseRate}%`}
            icon={Building2}
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <Card className="card-elevated xl:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">
                Application Trend (Last 6 Months)
              </CardTitle>
            </CardHeader>
            <CardContent className="h-80">
              {loading ? (
                <EmptyChartText text="Loading application trend…" />
              ) : totalTracked === 0 ? (
                <EmptyChartText text="No application history yet." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthlyTrend}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" />
                    <YAxis allowDecimals={false} />
                    <Tooltip />
                    <Bar
                      dataKey="applications"
                      fill="hsl(var(--primary))"
                      radius={[8, 8, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="card-elevated">
            <CardHeader>
              <CardTitle className="text-base">Professional Snapshot</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <InsightRow label="Most used source" value={topSource} />
              <InsightRow label="Top company applied" value={topCompany} />
              <InsightRow label="Interview rate" value={`${interviewRate}%`} />
              <InsightRow label="Offer rate" value={`${offerRate}%`} />
              <InsightRow
                label="Institute verified share"
                value={
                  totalTracked
                    ? `${Math.round((instituteVerifiedCount / totalTracked) * 100)}%`
                    : "0%"
                }
              />

              <div className="pt-2 flex flex-wrap gap-2">
                <Badge variant="secondary">
                  Institute Drives: {instituteVerifiedCount}
                </Badge>
                <Badge variant="secondary">Submitted: {totalSubmitted}</Badge>
                <Badge variant="secondary">Responses: {responseCount}</Badge>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          <ChartCard title="Status Breakdown">
            {loading ? (
              <EmptyChartText text="Loading status chart…" />
            ) : totalTracked === 0 ? (
              <EmptyChartText text="No statuses to visualize yet." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusPie}
                    dataKey="value"
                    nameKey="name"
                    outerRadius={95}
                    label
                  >
                    {statusPie.map((_, index) => (
                      <Cell
                        key={index}
                        fill={PIE_COLORS[index % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          <ChartCard title="Application Sources">
            {loading ? (
              <EmptyChartText text="Loading source mix…" />
            ) : totalTracked === 0 ? (
              <EmptyChartText text="Source mix will appear after you start tracking jobs." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={sourcePie}
                    dataKey="value"
                    nameKey="name"
                    outerRadius={95}
                    label
                  >
                    {sourcePie.map((_, index) => (
                      <Cell
                        key={index}
                        fill={PIE_COLORS[index % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          <ChartCard title="Internship vs Full-time">
            {loading ? (
              <EmptyChartText text="Loading job type split…" />
            ) : totalTracked === 0 ? (
              <EmptyChartText text="Job type split will appear here." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={jobTypePie}
                    dataKey="value"
                    nameKey="name"
                    outerRadius={95}
                    label
                  >
                    {jobTypePie.map((_, index) => (
                      <Cell
                        key={index}
                        fill={PIE_COLORS[index % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </ChartCard>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Card className="card-elevated">
            <CardHeader>
              <CardTitle className="text-base">
                Top Companies Applied To
              </CardTitle>
            </CardHeader>
            <CardContent className="h-80">
              {loading ? (
                <EmptyChartText text="Loading company data…" />
              ) : topCompanies.length === 0 ? (
                <EmptyChartText text="Once you start applying, your top companies will appear here." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={topCompanies}
                    layout="vertical"
                    margin={{ left: 24 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} />
                    <YAxis type="category" dataKey="company" width={100} />
                    <Tooltip />
                    <Bar
                      dataKey="applications"
                      fill="hsl(var(--primary))"
                      radius={[0, 8, 8, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="card-elevated">
            <CardHeader>
              <CardTitle className="text-base">Application Funnel</CardTitle>
            </CardHeader>
            <CardContent className="h-80">
              {loading ? (
                <EmptyChartText text="Loading funnel…" />
              ) : totalTracked === 0 ? (
                <EmptyChartText text="Your application funnel will appear here." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={funnelData}
                    layout="vertical"
                    margin={{ left: 12 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} />
                    <YAxis type="category" dataKey="stage" width={80} />
                    <Tooltip />
                    <Bar
                      dataKey="count"
                      fill="hsl(var(--primary))"
                      radius={[0, 8, 8, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}

function MetricCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: any;
}) {
  return (
    <Card className="card-elevated p-5">
      <div className="flex items-start gap-4">
        <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </div>
    </Card>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="card-elevated">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="h-80">{children}</CardContent>
    </Card>
  );
}

function InsightRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b last:border-b-0 pb-2 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold text-foreground text-right">
        {value}
      </span>
    </div>
  );
}

function EmptyChartText({ text }: { text: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
