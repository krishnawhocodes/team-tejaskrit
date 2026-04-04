import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Upload,
  Search,
  Filter,
  ChevronRight,
  ShieldCheck,
  X,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/StatusBadge";
import { branches, batches } from "@/lib/mock-data";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";

import { useAuth } from "@/auth/AuthProvider";
import type { ApplicationDoc, JobDoc } from "@/lib/types";
import {
  createInstituteJob,
  broadcastNewDriveToCandidates,
  jobIdFromAny,
  updateJobStatus,
  watchInstituteApplications,
  watchInstituteJobs,
} from "@/lib/firestore";
import { importJobFromPdf, type ImportedDriveForm } from "@/lib/import-job";

const steps = ["Job Details", "Eligibility", "Dates", "Publish"];

type Row = { id: string; data: JobDoc };

function formatDate(d: Date | null) {
  if (!d) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function isDeadlineSoon(deadline: Date | null) {
  if (!deadline) return false;
  const now = new Date();
  const diffMs = deadline.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= 3;
}

function toDateAny(v: any): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v?.toDate === "function") return v.toDate();
  if (typeof v?.toMillis === "function") return new Date(v.toMillis());
  if (typeof v?.seconds === "number") return new Date(v.seconds * 1000);
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "number") return new Date(v);
  return null;
}

export default function DrivesJobs() {
  const { toast } = useToast();
  const { user, profile } = useAuth();

  const instituteId = profile?.instituteId ?? null;

  const [searchText, setSearchText] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<Row[]>([]);
  const [apps, setApps] = useState<Array<{ id: string; data: ApplicationDoc }>>(
    [],
  );
  const [saving, setSaving] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportedDriveForm | null>(
    null,
  );
  const [importRawJson, setImportRawJson] = useState<any>(null);

  const [form, setForm] = useState({
    title: "",
    company: "",
    location: "",
    jobType: "" as "" | "Full-time" | "Internship",
    ctcOrStipend: "",
    applyUrl: "",
    jdText: "",

    eligibleBranches: [] as string[],
    batch: "",
    minCgpa: "",
    skillsCsv: "",
    seatLimit: "",

    deadlineLocal: "",
    oaLocal: "",
    interviewStart: "",
    interviewEnd: "",
  });

  useEffect(() => {
    if (!instituteId) return;

    setLoading(true);
    const u1 = watchInstituteJobs(instituteId, (rows) => {
      setJobs(rows);
      setLoading(false);
    });

    const u2 = watchInstituteApplications(instituteId, (rows) => setApps(rows));

    return () => {
      u1();
      u2();
    };
  }, [instituteId]);

  const appsByJobId = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of apps) {
      const jid = jobIdFromAny(a.data.jobId);
      if (!jid) continue;
      m.set(jid, (m.get(jid) ?? 0) + 1);
    }
    return m;
  }, [apps]);

  const filtered = useMemo(() => {
    const s = searchText.trim().toLowerCase();
    if (!s) return jobs;
    return jobs.filter(
      (r) =>
        r.data.title.toLowerCase().includes(s) ||
        r.data.company.toLowerCase().includes(s),
    );
  }, [jobs, searchText]);

  const selected = useMemo(
    () =>
      selectedJobId ? (jobs.find((d) => d.id === selectedJobId) ?? null) : null,
    [selectedJobId, jobs],
  );

  const estimatedEligible = useMemo(() => {
    const base = 180;
    const multiplier = Math.max(1, form.eligibleBranches.length);
    return base * multiplier;
  }, [form.eligibleBranches.length]);

  const resetWizard = () => {
    setCurrentStep(0);
    setForm({
      title: "",
      company: "",
      location: "",
      jobType: "",
      ctcOrStipend: "",
      applyUrl: "",
      jdText: "",

      eligibleBranches: [],
      batch: "",
      minCgpa: "",
      skillsCsv: "",
      seatLimit: "",

      deadlineLocal: "",
      oaLocal: "",
      interviewStart: "",
      interviewEnd: "",
    });
  };

  const resetImportDialog = () => {
    setImportFile(null);
    setImportResult(null);
    setImportRawJson(null);
  };

  const applyImportedToForm = (mapped: ImportedDriveForm) => {
    setForm({
      title: mapped.title || "",
      company: mapped.company || "",
      location: mapped.location || "",
      jobType: (mapped.jobType || "") as "" | "Full-time" | "Internship",
      ctcOrStipend: mapped.ctcOrStipend || "",
      applyUrl: mapped.applyUrl || "",
      jdText: mapped.jdText || "",

      eligibleBranches: mapped.eligibleBranches || [],
      batch: mapped.batch || "",
      minCgpa: mapped.minCgpa || "",
      skillsCsv: mapped.skillsCsv || "",
      seatLimit: mapped.seatLimit || "",

      deadlineLocal: mapped.deadlineLocal || "",
      oaLocal: mapped.oaLocal || "",
      interviewStart: mapped.interviewStart || "",
      interviewEnd: mapped.interviewEnd || "",
    });
  };

  const toggleBranch = (b: string, checked: boolean) => {
    setForm((p) => {
      const set = new Set(p.eligibleBranches);
      if (checked) set.add(b);
      else set.delete(b);
      return { ...p, eligibleBranches: Array.from(set) };
    });
  };

  const handleImportPdf = async () => {
    if (!importFile) {
      toast({
        title: "PDF required",
        description: "Please select a PDF first.",
        variant: "destructive",
      });
      return;
    }

    setImporting(true);
    try {
      const result = await importJobFromPdf(importFile);
      setImportRawJson(result.rawPdfJson);
      setImportResult(result.mapped);
      applyImportedToForm(result.mapped);

      toast({
        title: "PDF imported",
        description: "Review the extracted fields, then edit or post directly.",
      });
    } catch (e: any) {
      toast({
        title: "Import failed",
        description: e?.message || "Could not import this PDF.",
        variant: "destructive",
      });
    } finally {
      setImporting(false);
    }
  };

  const publish = async (formInput = form) => {
    if (!user || !instituteId) {
      toast({
        title: "Not ready",
        description: "Login and register your institute first.",
        variant: "destructive",
      });
      return;
    }

    if (!formInput.title.trim()) {
      return toast({ title: "Role title required", variant: "destructive" });
    }
    if (!formInput.company.trim()) {
      return toast({ title: "Company required", variant: "destructive" });
    }
    if (!formInput.deadlineLocal) {
      return toast({ title: "Deadline required", variant: "destructive" });
    }

    const deadlineDate = new Date(formInput.deadlineLocal);
    if (Number.isNaN(deadlineDate.getTime())) {
      toast({ title: "Invalid deadline date", variant: "destructive" });
      return;
    }

    const minCgpaNum =
      formInput.minCgpa.trim() === ""
        ? null
        : Number.parseFloat(formInput.minCgpa);

    const seatLimitNum =
      formInput.seatLimit.trim() === ""
        ? null
        : Number.parseInt(formInput.seatLimit, 10);

    const skills =
      formInput.skillsCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];

    const oaAt = formInput.oaLocal ? new Date(formInput.oaLocal) : null;
    const interviewStartAt = formInput.interviewStart
      ? new Date(formInput.interviewStart)
      : null;
    const interviewEndAt = formInput.interviewEnd
      ? new Date(formInput.interviewEnd)
      : null;

    setSaving(true);
    try {
      const jobId = await createInstituteJob({
        instituteId,
        createdBy: user.uid,
        title: formInput.title,
        company: formInput.company,
        location: formInput.location,
        jobType: formInput.jobType || "Internship",
        ctcOrStipend: formInput.ctcOrStipend,
        applyUrl: formInput.applyUrl,
        jdText: formInput.jdText,
        tags: skills,
        eligibility: {
          branches: formInput.eligibleBranches,
          batch: formInput.batch || null,
          minCgpa: minCgpaNum,
          skills,
          seatLimit: seatLimitNum,
        },
        deadlineAt: deadlineDate,
        oaAt,
        interviewStartAt,
        interviewEndAt,
      });

      try {
        await broadcastNewDriveToCandidates({
          instituteId,
          jobId,
          title: formInput.title.trim(),
          company: formInput.company.trim(),
          deadlineAt: deadlineDate,
          eligibility: {
            branches: formInput.eligibleBranches,
            batch: formInput.batch || null,
            minCgpa: minCgpaNum,
            skills,
            seatLimit: seatLimitNum,
          },
        });
      } catch (e) {
        console.warn("Drive notification failed", e);
      }

      toast({
        title: "Drive published",
        description: "Created in /jobs and notified eligible candidates.",
      });

      setWizardOpen(false);
      setImportOpen(false);
      resetWizard();
      resetImportDialog();
    } catch (err: any) {
      console.error(err);
      toast({
        title: "Publish failed",
        description: err?.message ?? "Check Firestore permissions.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const nextOrPublish = async () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep((s) => s + 1);
      return;
    }
    await publish();
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Drives & Jobs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Institute-verified campus placements (saved in /jobs)
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetImportDialog();
              setImportOpen(true);
            }}
          >
            <Upload className="w-4 h-4 mr-1.5" /> Import Job
          </Button>

          <Button
            size="sm"
            onClick={() => {
              resetWizard();
              setWizardOpen(true);
            }}
          >
            <Plus className="w-4 h-4 mr-1.5" /> Create New Drive
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search drives..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            className="pl-9"
          />
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            toast({ title: "Filters", description: "Coming soon." })
          }
        >
          <Filter className="w-4 h-4 mr-1.5" /> Filters
        </Button>
      </div>

      <div className="bg-card rounded-xl card-shadow border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/40">
                <th className="text-left text-xs font-semibold text-muted-foreground px-5 py-3.5">
                  Title
                </th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-5 py-3.5">
                  Company
                </th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-5 py-3.5">
                  Deadline
                </th>
                <th className="text-center text-xs font-semibold text-muted-foreground px-5 py-3.5">
                  Eligible
                </th>
                <th className="text-center text-xs font-semibold text-muted-foreground px-5 py-3.5">
                  Applicants
                </th>
                <th className="text-left text-xs font-semibold text-muted-foreground px-5 py-3.5">
                  Status
                </th>
                <th className="text-right text-xs font-semibold text-muted-foreground px-5 py-3.5">
                  Actions
                </th>
              </tr>
            </thead>

            <tbody>
              {loading && (
                <tr>
                  <td colSpan={7} className="px-5 py-10">
                    <div className="flex items-center justify-center gap-2 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="text-sm">Loading drives…</span>
                    </div>
                  </td>
                </tr>
              )}

              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10">
                    <div className="text-center text-sm text-muted-foreground">
                      No drives found. Create your first institute verified
                      drive.
                    </div>
                  </td>
                </tr>
              )}

              {!loading &&
                filtered.map((r) => {
                  const deadline = toDateAny(r.data.sourceMeta?.deadlineAt);
                  const status =
                    r.data.status === "closed"
                      ? "Closed"
                      : isDeadlineSoon(deadline)
                        ? "Deadline Soon"
                        : "Active";

                  const eligible =
                    (r.data.sourceMeta?.eligibility?.branches?.length ?? 0) > 0
                      ? 180 *
                        (r.data.sourceMeta?.eligibility?.branches?.length ?? 1)
                      : "—";

                  const applicants = appsByJobId.get(r.id) ?? 0;

                  return (
                    <tr
                      key={r.id}
                      className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors"
                    >
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {r.data.title}
                          </span>
                          <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                        </div>
                      </td>
                      <td className="px-5 py-4 text-sm text-foreground">
                        {r.data.company}
                      </td>
                      <td className="px-5 py-4 text-sm text-muted-foreground">
                        {formatDate(deadline)}
                      </td>
                      <td className="px-5 py-4 text-sm text-center text-foreground">
                        {eligible}
                      </td>
                      <td className="px-5 py-4 text-sm text-center text-foreground">
                        {applicants}
                      </td>
                      <td className="px-5 py-4">
                        <StatusBadge status={status} />
                      </td>
                      <td className="px-5 py-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedJobId(r.id)}
                        >
                          View <ChevronRight className="w-3.5 h-3.5 ml-1" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (!open) resetImportDialog();
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Import Job from PDF</DialogTitle>
          </DialogHeader>

          {!importResult ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Upload Job Profile PDF</Label>
                <Input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                />
                <p className="text-xs text-muted-foreground">
                  We will read the PDF in the browser, convert it into raw JSON,
                  send that JSON to Groq, and map it into your Create New Drive
                  fields.
                </p>
              </div>

              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={handleImportPdf}
                  disabled={importing}
                >
                  {importing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                      Importing…
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4 mr-1.5" />
                      Extract & Preview
                    </>
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4 max-h-[75vh] overflow-auto pr-1">
              <div className="bg-primary/5 border border-primary/10 rounded-lg p-4">
                <p className="text-sm font-semibold text-foreground mb-1">
                  Imported successfully
                </p>
                <p className="text-xs text-muted-foreground">
                  Review the extracted fields. You can edit them in the wizard
                  or post directly now.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs">Role Title</Label>
                  <div className="text-sm mt-1">
                    {importResult.title || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Company</Label>
                  <div className="text-sm mt-1">
                    {importResult.company || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Location</Label>
                  <div className="text-sm mt-1">
                    {importResult.location || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Job Type</Label>
                  <div className="text-sm mt-1">
                    {importResult.jobType || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">CTC / Stipend</Label>
                  <div className="text-sm mt-1">
                    {importResult.ctcOrStipend || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Apply Link</Label>
                  <div className="text-sm mt-1 break-all">
                    {importResult.applyUrl || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Eligible Branches</Label>
                  <div className="text-sm mt-1">
                    {importResult.eligibleBranches?.length
                      ? importResult.eligibleBranches.join(", ")
                      : "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Batch</Label>
                  <div className="text-sm mt-1">
                    {importResult.batch || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Min CGPA</Label>
                  <div className="text-sm mt-1">
                    {importResult.minCgpa || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Seat Limit</Label>
                  <div className="text-sm mt-1">
                    {importResult.seatLimit || "—"}
                  </div>
                </div>
                <div className="col-span-2">
                  <Label className="text-xs">Skills</Label>
                  <div className="text-sm mt-1">
                    {importResult.skillsCsv || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Deadline</Label>
                  <div className="text-sm mt-1">
                    {importResult.deadlineLocal || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">OA Date</Label>
                  <div className="text-sm mt-1">
                    {importResult.oaLocal || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Interview Start</Label>
                  <div className="text-sm mt-1">
                    {importResult.interviewStart || "—"}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Interview End</Label>
                  <div className="text-sm mt-1">
                    {importResult.interviewEnd || "—"}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Job Description</Label>
                <Textarea value={importResult.jdText || ""} readOnly rows={8} />
              </div>

              <div className="space-y-2">
                <Label>Missing Fields</Label>
                <div className="flex flex-wrap gap-2">
                  {importResult.missingFields?.length ? (
                    importResult.missingFields.map((f) => (
                      <Badge key={f} variant="outline">
                        {f}
                      </Badge>
                    ))
                  ) : (
                    <Badge>No missing fields flagged</Badge>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Raw JSON extracted from PDF</Label>
                <Textarea
                  value={JSON.stringify(importRawJson, null, 2)}
                  readOnly
                  rows={12}
                  className="font-mono text-xs"
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    applyImportedToForm(importResult);
                    setImportOpen(false);
                    setWizardOpen(true);
                    setCurrentStep(0);
                  }}
                >
                  Edit in Wizard
                </Button>

                <Button
                  size="sm"
                  onClick={async () => {
                    await publish(importResult);
                  }}
                  disabled={saving}
                >
                  {saving ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                      Posting…
                    </>
                  ) : (
                    "Post Now"
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selected} onOpenChange={() => setSelectedJobId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Drive details</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              <div>
                <p className="text-lg font-semibold">{selected.data.title}</p>
                <p className="text-sm text-muted-foreground">
                  {selected.data.company} · {selected.data.location || "—"}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">Institute Verified</Badge>
                <Badge variant="outline">
                  {selected.data.jobType || "Internship"}
                </Badge>
                {selected.data.status === "closed" ? (
                  <Badge variant="destructive">Closed</Badge>
                ) : (
                  <Badge>Open</Badge>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs">Deadline</Label>
                  <div className="text-sm">
                    {formatDate(
                      toDateAny(selected.data.sourceMeta?.deadlineAt),
                    )}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Applicants</Label>
                  <div className="text-sm">
                    {appsByJobId.get(selected.id) ?? 0}
                  </div>
                </div>
              </div>

              <div>
                <Label className="text-xs">Eligibility</Label>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(selected.data.sourceMeta?.eligibility?.branches ?? []).map(
                    (b) => (
                      <Badge key={b} variant="secondary">
                        {b}
                      </Badge>
                    ),
                  )}
                  {selected.data.sourceMeta?.eligibility?.minCgpa ? (
                    <Badge variant="outline">
                      CGPA ≥ {selected.data.sourceMeta.eligibility.minCgpa}
                    </Badge>
                  ) : null}
                  {selected.data.sourceMeta?.eligibility?.batch ? (
                    <Badge variant="outline">
                      Batch {selected.data.sourceMeta.eligibility.batch}
                    </Badge>
                  ) : null}
                </div>
              </div>

              <div>
                <Label className="text-xs">Job description</Label>
                <Textarea
                  className="mt-2"
                  value={selected.data.jdText || ""}
                  readOnly
                  rows={8}
                />
              </div>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={
                    selected.data.status === "closed"
                      ? "outline"
                      : "destructive"
                  }
                  onClick={async () => {
                    try {
                      await updateJobStatus(
                        selected.id,
                        selected.data.status === "closed" ? "open" : "closed",
                      );
                      toast({
                        title: "Updated",
                        description: "Drive status updated.",
                      });
                    } catch (e: any) {
                      toast({
                        title: "Failed",
                        description: e?.message ?? "Could not update status",
                        variant: "destructive",
                      });
                    }
                  }}
                >
                  {selected.data.status === "closed" ? "Reopen" : "Close"}
                </Button>

                {selected.data.applyUrl ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      window.open(
                        selected.data.applyUrl!,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    Open Apply Link
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
        <DialogContent className="w-[95vw] max-w-4xl h-[88vh] p-0 overflow-hidden flex flex-col">
          <DialogHeader className="px-6 pt-6 pb-3 border-b">
            <DialogTitle>Create New Drive</DialogTitle>
          </DialogHeader>

          <div className="px-6 py-4 border-b bg-background">
            <div className="flex items-center gap-2 flex-wrap">
              {steps.map((s, idx) => (
                <div key={s} className="flex items-center gap-2">
                  <div
                    className={`h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold ${
                      idx <= currentStep
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-muted-foreground"
                    }`}
                  >
                    {idx + 1}
                  </div>
                  <span
                    className={`text-xs ${
                      idx === currentStep
                        ? "text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    {s}
                  </span>
                  {idx < steps.length - 1 ? (
                    <div className="w-6 h-px bg-border" />
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {currentStep === 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 md:col-span-2">
                  <Label>Role Title</Label>
                  <Input
                    value={form.title}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, title: e.target.value }))
                    }
                    placeholder="Frontend Intern"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Company</Label>
                  <Input
                    value={form.company}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, company: e.target.value }))
                    }
                    placeholder="ABC"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Location</Label>
                  <Input
                    value={form.location}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, location: e.target.value }))
                    }
                    placeholder="Remote"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Job Type</Label>
                  <Select
                    value={form.jobType}
                    onValueChange={(v: any) =>
                      setForm((p) => ({ ...p, jobType: v }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Internship">Internship</SelectItem>
                      <SelectItem value="Full-time">Full-time</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>CTC / Stipend</Label>
                  <Input
                    value={form.ctcOrStipend}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, ctcOrStipend: e.target.value }))
                    }
                    placeholder="₹15k/month"
                  />
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label>Apply Link</Label>
                  <Input
                    value={form.applyUrl}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, applyUrl: e.target.value }))
                    }
                    placeholder="https://..."
                  />
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label>Job Description</Label>
                  <Textarea
                    value={form.jdText}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, jdText: e.target.value }))
                    }
                    rows={10}
                    className="min-h-[260px]"
                  />
                </div>
              </div>
            )}

            {currentStep === 1 && (
              <div className="space-y-5">
                <div>
                  <Label>Eligible Branches</Label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                    {branches.map((b) => (
                      <label
                        key={b}
                        className="flex items-center gap-2 text-sm cursor-pointer"
                      >
                        <Checkbox
                          checked={form.eligibleBranches.includes(b)}
                          onCheckedChange={(v) => toggleBranch(b, Boolean(v))}
                        />
                        {b}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Batch (optional)</Label>
                    <Select
                      value={form.batch}
                      onValueChange={(v) =>
                        setForm((p) => ({ ...p, batch: v }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                      <SelectContent>
                        {batches.map((b) => (
                          <SelectItem key={b} value={b}>
                            {b}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Min CGPA (optional)</Label>
                    <Input
                      value={form.minCgpa}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, minCgpa: e.target.value }))
                      }
                      placeholder="7.0"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Skills (comma-separated)</Label>
                    <Input
                      value={form.skillsCsv}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, skillsCsv: e.target.value }))
                      }
                      placeholder="React, Node, Firebase"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Seat limit (optional)</Label>
                    <Input
                      value={form.seatLimit}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, seatLimit: e.target.value }))
                      }
                      placeholder="50"
                    />
                  </div>
                </div>

                <div className="bg-secondary/30 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground">
                    Estimated eligible students (demo):{" "}
                    <span className="font-semibold text-foreground">
                      {estimatedEligible}
                    </span>
                  </p>
                </div>
              </div>
            )}

            {currentStep === 2 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 md:col-span-2">
                  <Label>Deadline</Label>
                  <Input
                    type="datetime-local"
                    value={form.deadlineLocal}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, deadlineLocal: e.target.value }))
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label>OA Date (optional)</Label>
                  <Input
                    type="datetime-local"
                    value={form.oaLocal}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, oaLocal: e.target.value }))
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label>Interview Start (optional)</Label>
                  <Input
                    type="datetime-local"
                    value={form.interviewStart}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, interviewStart: e.target.value }))
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label>Interview End (optional)</Label>
                  <Input
                    type="datetime-local"
                    value={form.interviewEnd}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, interviewEnd: e.target.value }))
                    }
                  />
                </div>
              </div>
            )}

            {currentStep === 3 && (
              <div className="space-y-4">
                <div className="bg-primary/5 border border-primary/10 rounded-lg p-4">
                  <p className="text-sm font-semibold text-foreground mb-1">
                    Ready to publish
                  </p>
                  <p className="text-xs text-muted-foreground">
                    This will create an Institute Verified job in /jobs.
                    Students will see it highlighted in their Candidate
                    dashboard.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Badge>Institute Verified</Badge>
                  <Badge variant="secondary">Visibility: institute</Badge>
                  <Badge variant="outline">Source: tpo</Badge>
                </div>
              </div>
            )}
          </div>

          <div className="border-t px-6 py-4 bg-background flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (currentStep === 0) {
                  setWizardOpen(false);
                  resetWizard();
                } else {
                  setCurrentStep((s) => Math.max(0, s - 1));
                }
              }}
            >
              {currentStep === 0 ? "Cancel" : "Back"}
            </Button>

            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={resetWizard}>
                <X className="w-4 h-4 mr-1.5" /> Reset
              </Button>

              <Button size="sm" onClick={nextOrPublish} disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                    Publishing…
                  </>
                ) : currentStep < steps.length - 1 ? (
                  "Next"
                ) : (
                  "Publish"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
