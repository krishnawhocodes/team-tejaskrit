import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Code,
  Database,
  Download,
  FileText,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import { motion } from "framer-motion";
import { useAuth } from "@/contexts/AuthProvider";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPrivateJobForUser,
  exportUserData,
  getJobsByIds,
  getMasterProfile,
  jobIdFromAny,
  listApplications,
  listInstituteJobs,
  listPublicJobs,
  listRecommendations,
  saveMasterProfile,
  saveUserConsents,
  deleteUserData,
} from "@/lib/firestore";
import { downloadResumePdf, generateTailoredLatex } from "@/lib/api";
import type { MasterProfileDoc, UserDoc } from "@/lib/types";
import { computeMatch } from "@/lib/match";
import { toast } from "@/hooks/use-toast";

type TailoredResumeUI = {
  applicationId: string;
  jobId: string;
  company: string;
  role: string;
  generatedAt?: string;
  status: "Ready" | "Generating" | "Failed";
  latex?: string;
  pdfUrl?: string; // legacy
  latexDocPath?: string; // legacy
  genId?: string;
};

function nowISODate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function splitBullets(s: string) {
  return s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

function bulletsToText(b?: string[]) {
  return (b ?? []).join("\n");
}

const EMPTY_PROFILE: MasterProfileDoc = {
  headline: "",
  summary: "",
  links: { linkedin: "", github: "", portfolio: "" },
  skills: [],
  education: [],
  experience: [],
  projects: [],
  achievements: [],
  masterText: "",
};

export default function Resume() {
  const { authUser, userDoc, signOut, refreshUserDoc } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const initialTab = (params.get("tab") as "master" | "tailored" | "privacy" | null) ?? "master";
  const [tab, setTab] = useState<"master" | "tailored" | "privacy">(initialTab);

  useEffect(() => {
    const t = (params.get("tab") as any) ?? "master";
    if (t === "master" || t === "tailored" || t === "privacy") setTab(t);
  }, [params]);

  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ["masterProfile", authUser?.uid],
    enabled: !!authUser?.uid,
    queryFn: () => getMasterProfile(authUser!.uid),
    staleTime: 30_000,
  });

  const [draft, setDraft] = useState<MasterProfileDoc>(EMPTY_PROFILE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft((profile ?? EMPTY_PROFILE) as MasterProfileDoc);
  }, [profile]);

  const consents: Required<NonNullable<UserDoc["consents"]>> = useMemo(
    () => ({
      resumeGeneration: userDoc?.consents?.resumeGeneration ?? true,
      jobMatching: userDoc?.consents?.jobMatching ?? true,
      shareWithTpo: userDoc?.consents?.shareWithTpo ?? false,
    }),
    [userDoc?.consents]
  );

  const [consentDraft, setConsentDraft] = useState(consents);
  useEffect(() => setConsentDraft(consents), [consents]);

  // Tailored resumes are derived from applications.
  const { data: apps } = useQuery({
    queryKey: ["applications", authUser?.uid],
    enabled: !!authUser?.uid,
    queryFn: () => listApplications(authUser!.uid),
    staleTime: 15_000,
  });

  const { data: jobMap } = useQuery({
    queryKey: ["jobsForResume", authUser?.uid, (apps ?? []).map((a) => a.data.jobId).join(",")],
    enabled: !!authUser?.uid && (apps?.length ?? 0) > 0,
    queryFn: async () => {
      const ids = (apps ?? []).map((a) => jobIdFromAny(a.data.jobId));
      return await getJobsByIds(ids);
    },
    staleTime: 30_000,
  });

  const tailoredResumes: TailoredResumeUI[] = useMemo(() => {
    const rows = apps ?? [];
    const map = jobMap ?? {};
    return rows
      .filter(
        (a) =>
          a.data.status === "tailored" ||
          !!a.data.tailoredResume?.genId ||
          !!a.data.tailoredResume?.pdfUrl ||
          !!a.data.tailoredResume?.latex
      )
      .map((a) => {
        const jobId = jobIdFromAny(a.data.jobId);
        const job = map[jobId];
        const pdfUrl = a.data.tailoredResume?.pdfUrl;
        const latex = a.data.tailoredResume?.latex;
        const genId = a.data.tailoredResume?.genId;
        const generatedAt = (a.data.tailoredResume?.generatedAt as any)?.toMillis?.()
          ? new Date((a.data.tailoredResume?.generatedAt as any).toMillis()).toLocaleDateString()
          : undefined;
        return {
          applicationId: a.id,
          jobId,
          company: job?.company ?? "(Company)",
          role: job?.title ?? "(Role)",
          generatedAt,
          status: latex ? "Ready" : genId ? "Generating" : "Failed",
          latex,
          pdfUrl,
          latexDocPath: a.data.tailoredResume?.latexDocPath,
          genId,
        };
      })
      .sort((a, b) => (b.generatedAt ?? "").localeCompare(a.generatedAt ?? ""));
  }, [apps, jobMap]);

  const saveProfile = async () => {
    if (!authUser?.uid) return;
    try {
      setSaving(true);
      await saveMasterProfile(authUser.uid, {
        ...draft,
        // ensure arrays exist
        skills: draft.skills ?? [],
        education: draft.education ?? [],
        experience: draft.experience ?? [],
        projects: draft.projects ?? [],
        achievements: draft.achievements ?? [],
      });
      toast({ title: "Saved", description: "Master resume updated." });
      qc.invalidateQueries({ queryKey: ["masterProfile", authUser.uid] });
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message ?? "Could not save.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // Generate tailored resume
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateMode, setGenerateMode] = useState<"feed" | "manual">("feed");
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [manualJob, setManualJob] = useState({
    title: "",
    company: "",
    location: "",
    jobType: "Internship" as "Internship" | "Full-time",
    applyUrl: "",
    jdText: "",
    tags: "",
  });
  const [generating, setGenerating] = useState(false);

  const { data: jobOptions } = useQuery({
    queryKey: ["resumeJobOptions", authUser?.uid, userDoc?.instituteId],
    enabled: !!authUser?.uid,
    queryFn: async () => {
      if (!authUser?.uid) return [] as Array<{ id: string; title: string; company: string; score: number }>;

      // Try recommendations first
      const recs = await listRecommendations(authUser.uid, 25);
      if (recs.length > 0) {
        const ids = recs.map((r) => jobIdFromAny(r.data.jobId ?? r.id));
        const map = await getJobsByIds(ids);
        return recs
          .map((r) => {
            const id = jobIdFromAny(r.data.jobId ?? r.id);
            const j = map[id];
            if (!j) return null;
            return { id, title: j.title, company: j.company, score: r.data.score };
          })
          .filter(Boolean) as any;
      }

      // fallback: public + institute
      const pub = await listPublicJobs(25);
      const inst = userDoc?.instituteId ? await listInstituteJobs(userDoc.instituteId, 25) : [];
      const items = [...pub, ...inst];

      return items.map((x) => {
        const m = computeMatch(x.data, profile);
        return { id: x.id, title: x.data.title, company: x.data.company, score: m.score };
      });
    },
    staleTime: 60_000,
  });

  const doGenerate = async () => {
    if (!authUser?.uid) return;
    if (!consentDraft.resumeGeneration) {
      toast({
        title: "Resume generation disabled",
        description: "Enable it in Data & Privacy to generate tailored resumes.",
        variant: "destructive",
      });
      setGenerateOpen(false);
      setParams({ tab: "privacy" });
      return;
    }

    try {
      setGenerating(true);

      let jobId = selectedJobId;
      if (generateMode === "manual") {
        if (!manualJob.title.trim() || !manualJob.company.trim()) {
          toast({ title: "Missing fields", description: "Enter job title and company." });
          return;
        }
        jobId = await createPrivateJobForUser({
          uid: authUser.uid,
          title: manualJob.title.trim(),
          company: manualJob.company.trim(),
          location: manualJob.location.trim(),
          jobType: manualJob.jobType,
          applyUrl: manualJob.applyUrl.trim(),
          jdText: manualJob.jdText.trim(),
          tags: manualJob.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          source: "manual",
        });
      }

      if (!jobId) {
        toast({ title: "Select a job", description: "Pick a job from your feed or add one manually." });
        return;
      }

      await generateTailoredLatex({ jobId });

      toast({
        title: "Tailored resume generated",
        description: "LaTeX saved to your tracker. Download it from Tailored Resumes tab.",
      });

      setGenerateOpen(false);
      setSelectedJobId("");
      qc.invalidateQueries({ queryKey: ["applications", authUser.uid] });
    } catch (e: any) {
      toast({ title: "Failed", description: e?.message ?? "Could not generate.", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  const regenerate = async (r: TailoredResumeUI) => {
    if (!authUser?.uid) return;
    try {
      await generateTailoredLatex({ jobId: r.jobId });
      toast({ title: "Regenerated", description: "Updated LaTeX stored. Download again." });
      qc.invalidateQueries({ queryKey: ["applications", authUser.uid] });
    } catch (e: any) {
      toast({ title: "Failed", description: e?.message ?? "Could not request.", variant: "destructive" });
    }
  };

  const savePrivacy = async () => {
    if (!authUser?.uid) return;
    try {
      await saveUserConsents(authUser.uid, consentDraft);
      await refreshUserDoc();
      toast({ title: "Preferences saved" });
    } catch (e: any) {
      toast({ title: "Failed", description: e?.message ?? "Could not save preferences.", variant: "destructive" });
    }
  };

  const doExport = async () => {
    if (!authUser?.uid) return;
    try {
      const data = await exportUserData(authUser.uid);
      downloadJson(`tejaskrit-export-${nowISODate()}.json`, data);
      toast({ title: "Export started", description: "Downloaded your data as JSON." });
    } catch (e: any) {
      toast({ title: "Export failed", description: e?.message ?? "Could not export.", variant: "destructive" });
    }
  };

  const doDelete = async () => {
    if (!authUser?.uid) return;
    try {
      await deleteUserData(authUser.uid);
      toast({ title: "Data deleted", description: "Your Firestore data has been removed (Auth account remains)." });
      await signOut();
      navigate("/login");
    } catch (e: any) {
      toast({ title: "Delete failed", description: e?.message ?? "Could not delete.", variant: "destructive" });
    }
  };

  return (
    <AppLayout>
      <div className="page-container">
        <h1 className="text-2xl font-bold mb-1">Resume</h1>
        <p className="text-sm text-muted-foreground mb-6">Manage your master resume and generate tailored versions</p>

        <Tabs
          value={tab}
          onValueChange={(v) => {
            const next = v as any;
            setTab(next);
            setParams({ tab: next });
          }}
        >
          <TabsList className="mb-6">
            <TabsTrigger value="master">Master Resume</TabsTrigger>
            <TabsTrigger value="tailored">Tailored Resumes ({tailoredResumes.length})</TabsTrigger>
            <TabsTrigger value="privacy">Data & Privacy</TabsTrigger>
          </TabsList>

          {/* MASTER */}
          <TabsContent value="master">
            <div className="space-y-6">
              <Card className="card-elevated p-5">
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label>Headline</Label>
                    <Input
                      value={draft.headline ?? ""}
                      onChange={(e) => setDraft((p) => ({ ...p, headline: e.target.value }))}
                      placeholder="e.g. Final year IT student | React + Node"
                    />
                  </div>
                  <div>
                    <Label>Location (optional)</Label>
                    <Input
                      value={userDoc?.prefs?.locations?.[0] ?? ""}
                      readOnly
                      placeholder="Set in onboarding"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">Location is stored in user preferences (onboarding).</p>
                  </div>
                </div>
              </Card>

              <Card className="card-elevated p-5">
                <h3 className="font-semibold text-sm mb-3">Summary</h3>
                <Textarea
                  value={draft.summary ?? ""}
                  onChange={(e) => setDraft((p) => ({ ...p, summary: e.target.value }))}
                  rows={4}
                  className="text-sm"
                />
              </Card>

              <Card className="card-elevated p-5">
                <h3 className="font-semibold text-sm mb-3">Links</h3>
                <div className="grid md:grid-cols-3 gap-4">
                  <div>
                    <Label>LinkedIn</Label>
                    <Input
                      value={draft.links?.linkedin ?? ""}
                      onChange={(e) => setDraft((p) => ({ ...p, links: { ...(p.links ?? {}), linkedin: e.target.value } }))}
                      placeholder="linkedin.com/in/..."
                    />
                  </div>
                  <div>
                    <Label>GitHub</Label>
                    <Input
                      value={draft.links?.github ?? ""}
                      onChange={(e) => setDraft((p) => ({ ...p, links: { ...(p.links ?? {}), github: e.target.value } }))}
                      placeholder="github.com/..."
                    />
                  </div>
                  <div>
                    <Label>Portfolio</Label>
                    <Input
                      value={draft.links?.portfolio ?? ""}
                      onChange={(e) => setDraft((p) => ({ ...p, links: { ...(p.links ?? {}), portfolio: e.target.value } }))}
                      placeholder="yoursite.dev"
                    />
                  </div>
                </div>
              </Card>

              {/* Skills */}
              <Card className="card-elevated p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-sm">Skills</h3>
                </div>
                <SkillsEditor
                  skills={draft.skills ?? []}
                  onChange={(skills) => setDraft((p) => ({ ...p, skills }))}
                />
              </Card>

              {/* Education */}
              <Card className="card-elevated p-5">
                <ArraySectionHeader
                  title="Education"
                  onAdd={() =>
                    setDraft((p) => ({
                      ...p,
                      education: [
                        ...(p.education ?? []),
                        { institute: "", degree: "", branch: "", startYear: undefined, endYear: undefined, cgpa: undefined },
                      ],
                    }))
                  }
                />
                <div className="space-y-3">
                  {(draft.education ?? []).map((e, idx) => (
                    <Card key={idx} className="p-4 bg-muted/50 border border-border">
                      <div className="grid md:grid-cols-2 gap-3">
                        <div>
                          <Label>Institute</Label>
                          <Input
                            value={e.institute}
                            onChange={(ev) => updateArrayItem(setDraft, "education", idx, { ...e, institute: ev.target.value })}
                            placeholder="MITS Gwalior"
                          />
                        </div>
                        <div>
                          <Label>Degree</Label>
                          <Input
                            value={e.degree}
                            onChange={(ev) => updateArrayItem(setDraft, "education", idx, { ...e, degree: ev.target.value })}
                            placeholder="B.Tech"
                          />
                        </div>
                        <div>
                          <Label>Branch</Label>
                          <Input
                            value={e.branch ?? ""}
                            onChange={(ev) => updateArrayItem(setDraft, "education", idx, { ...e, branch: ev.target.value })}
                            placeholder="IT"
                          />
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                          <div>
                            <Label>Start</Label>
                            <Input
                              value={e.startYear ?? ""}
                              onChange={(ev) =>
                                updateArrayItem(setDraft, "education", idx, { ...e, startYear: numOrUndef(ev.target.value) })
                              }
                              placeholder="2022"
                            />
                          </div>
                          <div>
                            <Label>End</Label>
                            <Input
                              value={e.endYear ?? ""}
                              onChange={(ev) =>
                                updateArrayItem(setDraft, "education", idx, { ...e, endYear: numOrUndef(ev.target.value) })
                              }
                              placeholder="2026"
                            />
                          </div>
                          <div>
                            <Label>CGPA</Label>
                            <Input
                              value={e.cgpa ?? ""}
                              onChange={(ev) =>
                                updateArrayItem(setDraft, "education", idx, {
                                  ...e,
                                  cgpa: floatOrUndef(ev.target.value),
                                })
                              }
                              placeholder="8.5"
                            />
                          </div>
                        </div>
                      </div>
                      <div className="flex justify-end mt-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-destructive gap-1"
                          onClick={() => removeArrayItem(setDraft, "education", idx)}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Remove
                        </Button>
                      </div>
                    </Card>
                  ))}

                  {(draft.education ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">Add your education to improve matching.</p>
                  ) : null}
                </div>
              </Card>

              {/* Experience */}
              <Card className="card-elevated p-5">
                <ArraySectionHeader
                  title="Experience"
                  onAdd={() =>
                    setDraft((p) => ({
                      ...p,
                      experience: [
                        ...(p.experience ?? []),
                        { title: "", company: "", start: "", end: "", bullets: [] },
                      ],
                    }))
                  }
                />
                <div className="space-y-3">
                  {(draft.experience ?? []).map((e, idx) => (
                    <Card key={idx} className="p-4 bg-muted/50 border border-border">
                      <div className="grid md:grid-cols-2 gap-3">
                        <div>
                          <Label>Role</Label>
                          <Input
                            value={e.title}
                            onChange={(ev) => updateArrayItem(setDraft, "experience", idx, { ...e, title: ev.target.value })}
                            placeholder="SDE Intern"
                          />
                        </div>
                        <div>
                          <Label>Company</Label>
                          <Input
                            value={e.company}
                            onChange={(ev) => updateArrayItem(setDraft, "experience", idx, { ...e, company: ev.target.value })}
                            placeholder="Company"
                          />
                        </div>
                        <div>
                          <Label>Start (YYYY-MM)</Label>
                          <Input
                            value={e.start ?? ""}
                            onChange={(ev) => updateArrayItem(setDraft, "experience", idx, { ...e, start: ev.target.value })}
                            placeholder="2025-06"
                          />
                        </div>
                        <div>
                          <Label>End (YYYY-MM or Present)</Label>
                          <Input
                            value={e.end ?? ""}
                            onChange={(ev) => updateArrayItem(setDraft, "experience", idx, { ...e, end: ev.target.value })}
                            placeholder="2025-08"
                          />
                        </div>
                      </div>
                      <div className="mt-3">
                        <Label>Bullets (one per line)</Label>
                        <Textarea
                          value={bulletsToText(e.bullets)}
                          onChange={(ev) =>
                            updateArrayItem(setDraft, "experience", idx, { ...e, bullets: splitBullets(ev.target.value) })
                          }
                          rows={3}
                        />
                      </div>
                      <div className="flex justify-end mt-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-destructive gap-1"
                          onClick={() => removeArrayItem(setDraft, "experience", idx)}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Remove
                        </Button>
                      </div>
                    </Card>
                  ))}

                  {(draft.experience ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">Add internships/projects experience to stand out.</p>
                  ) : null}
                </div>
              </Card>

              {/* Projects */}
              <Card className="card-elevated p-5">
                <ArraySectionHeader
                  title="Projects"
                  onAdd={() =>
                    setDraft((p) => ({
                      ...p,
                      projects: [
                        ...(p.projects ?? []),
                        { name: "", tech: [], bullets: [], link: "" },
                      ],
                    }))
                  }
                />
                <div className="space-y-3">
                  {(draft.projects ?? []).map((p, idx) => (
                    <Card key={idx} className="p-4 bg-muted/50 border border-border">
                      <div className="grid md:grid-cols-2 gap-3">
                        <div>
                          <Label>Name</Label>
                          <Input
                            value={p.name}
                            onChange={(ev) => updateArrayItem(setDraft, "projects", idx, { ...p, name: ev.target.value })}
                            placeholder="Project name"
                          />
                        </div>
                        <div>
                          <Label>Link</Label>
                          <Input
                            value={p.link ?? ""}
                            onChange={(ev) => updateArrayItem(setDraft, "projects", idx, { ...p, link: ev.target.value })}
                            placeholder="https://..."
                          />
                        </div>
                      </div>
                      <div className="mt-3">
                        <Label>Tech (comma separated)</Label>
                        <Input
                          value={(p.tech ?? []).join(", ")}
                          onChange={(ev) =>
                            updateArrayItem(setDraft, "projects", idx, {
                              ...p,
                              tech: ev.target.value
                                .split(",")
                                .map((t) => t.trim())
                                .filter(Boolean),
                            })
                          }
                          placeholder="React, Firebase, ..."
                        />
                      </div>
                      <div className="mt-3">
                        <Label>Bullets (one per line)</Label>
                        <Textarea
                          value={bulletsToText(p.bullets)}
                          onChange={(ev) =>
                            updateArrayItem(setDraft, "projects", idx, { ...p, bullets: splitBullets(ev.target.value) })
                          }
                          rows={3}
                        />
                      </div>
                      <div className="flex justify-end mt-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-destructive gap-1"
                          onClick={() => removeArrayItem(setDraft, "projects", idx)}
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Remove
                        </Button>
                      </div>
                    </Card>
                  ))}

                  {(draft.projects ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">Add 2–3 strong projects for better matching.</p>
                  ) : null}
                </div>
              </Card>

              {/* Achievements */}
              <Card className="card-elevated p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-sm">Achievements</h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs gap-1"
                    onClick={() => setDraft((p) => ({ ...p, achievements: [...(p.achievements ?? []), ""] }))}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Button>
                </div>
                <div className="space-y-2">
                  {(draft.achievements ?? []).map((a, idx) => (
                    <div key={idx} className="flex gap-2 items-start">
                      <Input
                        value={a}
                        onChange={(ev) =>
                          setDraft((p) => {
                            const arr = [...(p.achievements ?? [])];
                            arr[idx] = ev.target.value;
                            return { ...p, achievements: arr };
                          })
                        }
                        placeholder="Achievement"
                      />
                      <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => removeStringItem(setDraft, "achievements", idx)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  {(draft.achievements ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">Add achievements (hackathons, ranks, certifications).</p>
                  ) : null}
                </div>
              </Card>

              <div className="flex flex-wrap gap-2">
                <Button onClick={saveProfile} disabled={saving || profileLoading} className="gap-1">
                  {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
                  Save Changes
                </Button>
                <Button variant="outline" className="gap-1" onClick={() => setGenerateOpen(true)}>
                  <FileText className="h-4 w-4" /> Generate Tailored Resume
                </Button>
              </div>
            </div>
          </TabsContent>

          {/* TAILORED */}
          <TabsContent value="tailored">
            <div className="space-y-3">
              <div className="flex justify-end mb-2">
                <Button size="sm" className="gap-1 text-xs" onClick={() => setGenerateOpen(true)}>
                  <Plus className="h-3.5 w-3.5" /> Generate New
                </Button>
              </div>

              {tailoredResumes.length === 0 ? (
                <Card className="card-elevated p-10 text-center text-sm text-muted-foreground">
                  No tailored resumes yet. Generate one from a job in your feed.
                </Card>
              ) : (
                <div className="space-y-2">
                  {tailoredResumes.map((r, i) => (
                    <motion.div key={r.applicationId} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                      <Card className="card-elevated p-4 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-9 w-9 rounded-lg bg-accent flex items-center justify-center shrink-0">
                            <FileText className="h-4 w-4 text-accent-foreground" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {r.role} — {r.company}
                            </p>
                            <p className="text-xs text-muted-foreground">{r.generatedAt ? `Generated ${r.generatedAt}` : "Generation requested"}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge
                            variant={r.status === "Ready" ? "default" : r.status === "Generating" ? "secondary" : "destructive"}
                            className="text-xs"
                          >
                            {r.status}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={async () => {
                              try {
                                if (r.status !== "Ready") {
                                  toast({ title: "Not ready", description: "Generate resume first." });
                                  return;
                                }
                                await downloadResumePdf(r.applicationId);
                              } catch (e: any) {
                                toast({ title: "Download failed", description: e?.message ?? "Try again.", variant: "destructive" });
                              }
                            }}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => {
                              if (!r.latex) {
                                toast({ title: "Not ready", description: "LaTeX not available yet." });
                                return;
                              }
                              navigate(`/resume/editor/${encodeURIComponent(r.applicationId)}`);
                            }}
                          >
                            <Code className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => regenerate(r)}>
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </Card>
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          {/* PRIVACY */}
          <TabsContent value="privacy">
            <div className="space-y-6 max-w-lg">
              <Card className="card-elevated p-6 space-y-6">
                <div>
                  <h3 className="font-semibold text-sm mb-1 flex items-center gap-2">
                    <Shield className="h-4 w-4" /> Privacy Preferences
                  </h3>
                  <p className="text-xs text-muted-foreground">Control how your data is used</p>
                </div>
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm">Allow resume generation</p>
                      <p className="text-xs text-muted-foreground">Use profile data to request AI resume tailoring</p>
                    </div>
                    <Switch
                      checked={!!consentDraft.resumeGeneration}
                      onCheckedChange={(v) => setConsentDraft((p) => ({ ...p, resumeGeneration: v }))}
                    />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm">Allow job matching</p>
                      <p className="text-xs text-muted-foreground">Use your skills/preferences to compute match score</p>
                    </div>
                    <Switch
                      checked={!!consentDraft.jobMatching}
                      onCheckedChange={(v) => setConsentDraft((p) => ({ ...p, jobMatching: v }))}
                    />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm">Share with TPO</p>
                      <p className="text-xs text-muted-foreground">Allow college placement office to view your applications</p>
                    </div>
                    <Switch
                      checked={!!consentDraft.shareWithTpo}
                      onCheckedChange={(v) => setConsentDraft((p) => ({ ...p, shareWithTpo: v }))}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  <Button size="sm" onClick={savePrivacy}>
                    Save Preferences
                  </Button>
                  <Button variant="outline" size="sm" className="gap-1" onClick={doExport}>
                    <Database className="h-3.5 w-3.5" /> Export My Data
                  </Button>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1 text-destructive">
                        <Trash2 className="h-3.5 w-3.5" /> Delete My Data
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete your data?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will delete your Firestore data (profile, applications, notifications). Your Firebase Auth account will remain.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={doDelete}>
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </Card>
            </div>
          </TabsContent>
        </Tabs>

        {/* Generate Modal */}
        <Dialog
          open={generateOpen}
          onOpenChange={(o) => {
            setGenerateOpen(o);
            if (!o) {
              setGenerating(false);
              setSelectedJobId("");
              setGenerateMode("feed");
              setManualJob({ title: "", company: "", location: "", jobType: "Internship", applyUrl: "", jdText: "", tags: "" });
            }
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Generate Tailored Resume</DialogTitle>
            </DialogHeader>

            <div className="flex gap-2">
              <Button
                variant={generateMode === "feed" ? "default" : "outline"}
                size="sm"
                className="text-xs"
                onClick={() => setGenerateMode("feed")}
              >
                From Feed
              </Button>
              <Button
                variant={generateMode === "manual" ? "default" : "outline"}
                size="sm"
                className="text-xs"
                onClick={() => setGenerateMode("manual")}
              >
                Manual Job
              </Button>
            </div>

            {generateMode === "feed" ? (
              <div className="space-y-4 mt-4">
                <div>
                  <Label>Select Job</Label>
                  <Select value={selectedJobId} onValueChange={setSelectedJobId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Search and select a job..." />
                    </SelectTrigger>
                    <SelectContent>
                      {(jobOptions ?? []).map((j) => (
                        <SelectItem key={j.id} value={j.id}>
                          {j.title} — {j.company} {j.score ? `(${j.score}%)` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Card className="p-3 bg-accent/50">
                  <p className="text-xs font-medium mb-1">Key emphasis areas (preview)</p>
                  <ul className="text-xs text-muted-foreground space-y-0.5">
                    <li>• Highlight your most relevant skills</li>
                    <li>• Emphasize matching projects & impact</li>
                    <li>• Keep it ATS-friendly and concise</li>
                  </ul>
                </Card>

                <Button className="w-full gap-1" onClick={doGenerate} disabled={generating}>
                  {generating ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Generating…
                    </>
                  ) : (
                    <>
                      <FileText className="h-3.5 w-3.5" /> Generate Resume
                    </>
                  )}
                </Button>

                <p className="text-[11px] text-muted-foreground">
                  Note: In MVP, we store a generation request in Firestore. A Cloud Function/worker can compile LaTeX → PDF and update the
                  application.
                </p>
              </div>
            ) : (
              <div className="space-y-4 mt-4">
                <div className="grid md:grid-cols-2 gap-3">
                  <div>
                    <Label>Job Title</Label>
                    <Input value={manualJob.title} onChange={(e) => setManualJob((p) => ({ ...p, title: e.target.value }))} />
                  </div>
                  <div>
                    <Label>Company</Label>
                    <Input value={manualJob.company} onChange={(e) => setManualJob((p) => ({ ...p, company: e.target.value }))} />
                  </div>
                  <div>
                    <Label>Location</Label>
                    <Input value={manualJob.location} onChange={(e) => setManualJob((p) => ({ ...p, location: e.target.value }))} />
                  </div>
                  <div>
                    <Label>Job Type</Label>
                    <Select value={manualJob.jobType} onValueChange={(v) => setManualJob((p) => ({ ...p, jobType: v as any }))}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Internship">Internship</SelectItem>
                        <SelectItem value="Full-time">Full-time</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label>Apply Link (optional)</Label>
                  <Input value={manualJob.applyUrl} onChange={(e) => setManualJob((p) => ({ ...p, applyUrl: e.target.value }))} placeholder="https://..." />
                </div>
                <div>
                  <Label>Skills/Tags (comma separated, optional)</Label>
                  <Input value={manualJob.tags} onChange={(e) => setManualJob((p) => ({ ...p, tags: e.target.value }))} placeholder="react, firebase, ..." />
                </div>
                <div>
                  <Label>Job Description</Label>
                  <Textarea value={manualJob.jdText} onChange={(e) => setManualJob((p) => ({ ...p, jdText: e.target.value }))} rows={5} />
                </div>
                <Button className="w-full gap-1" onClick={doGenerate} disabled={generating}>
                  {generating ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Creating…
                    </>
                  ) : (
                    <>
                      <FileText className="h-3.5 w-3.5" /> Generate Resume
                    </>
                  )}
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>

      </div>
    </AppLayout>
  );
}

function SkillsEditor({ skills, onChange }: { skills: string[]; onChange: (skills: string[]) => void }) {
  const [input, setInput] = useState("");
  const add = () => {
    const s = input.trim();
    if (!s) return;
    if (skills.map((x) => x.toLowerCase()).includes(s.toLowerCase())) {
      setInput("");
      return;
    }
    onChange([...skills, s]);
    setInput("");
  };
  return (
    <div>
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. React"
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
        />
        <Button type="button" variant="outline" onClick={add} className="gap-1">
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-3">
        {skills.map((s) => (
          <Badge key={s} variant="secondary" className="gap-1">
            {s}
            <button type="button" onClick={() => onChange(skills.filter((x) => x !== s))} className="ml-1">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {skills.length === 0 ? <span className="text-sm text-muted-foreground">No skills yet.</span> : null}
      </div>
    </div>
  );
}

function ArraySectionHeader({ title, onAdd }: { title: string; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="font-semibold text-sm">{title}</h3>
      <Button variant="ghost" size="sm" className="text-xs gap-1" onClick={onAdd}>
        <Plus className="h-3.5 w-3.5" /> Add
      </Button>
    </div>
  );
}

function numOrUndef(v: string) {
  const s = v.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function floatOrUndef(v: string) {
  const s = v.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function updateArrayItem<T extends Record<string, any>>(
  setDraft: any,
  key: keyof T,
  idx: number,
  item: any
) {
  setDraft((p) => {
    const arr = Array.isArray((p as any)[key]) ? [...((p as any)[key] as any[])] : [];
    arr[idx] = item;
    return { ...(p as any), [key]: arr };
  });
}

function removeArrayItem<T extends Record<string, any>>(
  setDraft: any,
  key: keyof T,
  idx: number
) {
  setDraft((p) => {
    const arr = Array.isArray((p as any)[key]) ? [...((p as any)[key] as any[])] : [];
    arr.splice(idx, 1);
    return { ...(p as any), [key]: arr };
  });
}

function removeStringItem<T extends Record<string, any>>(
  setDraft: any,
  key: keyof T,
  idx: number
) {
  setDraft((p) => {
    const arr = Array.isArray((p as any)[key]) ? [...((p as any)[key] as any[])] : [];
    arr.splice(idx, 1);
    return { ...(p as any), [key]: arr };
  });
}
