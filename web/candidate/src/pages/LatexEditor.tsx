import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  Copy,
  Download,
  Eye,
  FileText,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  Undo2,
} from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/contexts/AuthProvider";
import { toast } from "@/hooks/use-toast";
import { aiAssistTailoredLatex, downloadResumePdf, getLatexPreviewPdf, saveTailoredLatex } from "@/lib/api";
import { getApplicationById, getJobById, getMasterProfile, jobIdFromAny } from "@/lib/firestore";

function formatTs(value: any) {
  const ms = value?.toMillis?.();
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function looksLikeLatex(tex: string) {
  const t = tex.trim();
  return t.includes("\\documentclass") && t.includes("\\begin{document}") && t.includes("\\end{document}");
}

export default function LatexEditor() {
  const { applicationId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { authUser } = useAuth();

  const [draftLatex, setDraftLatex] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const previewReq = useRef(0);

  const applicationQuery = useQuery({
    queryKey: ["application", applicationId],
    enabled: !!applicationId,
    queryFn: async () => {
      const app = await getApplicationById(applicationId);
      if (!app) throw new Error("Tailored resume not found.");
      return app;
    },
    staleTime: 10_000,
  });

  const jobId = useMemo(() => jobIdFromAny(applicationQuery.data?.data.jobId ?? ""), [applicationQuery.data?.data.jobId]);

  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    enabled: !!jobId,
    queryFn: async () => {
      const job = await getJobById(jobId);
      if (!job) throw new Error("Job details not found.");
      return job;
    },
    staleTime: 30_000,
  });

  const profileQuery = useQuery({
    queryKey: ["masterProfile", authUser?.uid],
    enabled: !!authUser?.uid,
    queryFn: () => getMasterProfile(authUser!.uid),
    staleTime: 30_000,
  });

  const savedLatex = applicationQuery.data?.data.tailoredResume?.latex ?? "";
  const savedGeneratedAt = applicationQuery.data?.data.tailoredResume?.generatedAt;
  const savedEditedAt = (applicationQuery.data?.data.tailoredResume as any)?.editedAt;

  useEffect(() => {
    setDraftLatex(savedLatex);
  }, [savedLatex, applicationId]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const isDirty = draftLatex.trim() !== savedLatex.trim();

  const refreshPreview = async (latexToCompile = draftLatex) => {
    const latex = latexToCompile.trim();
    if (!latex) {
      setPreviewError("No LaTeX content to preview.");
      return;
    }
    if (!looksLikeLatex(latex)) {
      setPreviewError("Preview needs a full LaTeX document with \\documentclass, \\begin{document}, and \\end{document}.");
      return;
    }

    const reqId = ++previewReq.current;
    setPreviewLoading(true);
    setPreviewError("");

    try {
      const blob = await getLatexPreviewPdf(latex);
      if (reqId !== previewReq.current) return;
      const nextUrl = URL.createObjectURL(blob);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return nextUrl;
      });
    } catch (e: any) {
      if (reqId !== previewReq.current) return;
      setPreviewError(e?.message ?? "Preview failed.");
    } finally {
      if (reqId === previewReq.current) setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (!draftLatex.trim()) {
      setPreviewError("No LaTeX content to preview.");
      return;
    }
    const timer = window.setTimeout(() => {
      void refreshPreview(draftLatex);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [draftLatex]);

  const handleSave = async () => {
    if (!applicationId) return;
    try {
      setSaving(true);
      await saveTailoredLatex({ applicationId, latex: draftLatex });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["application", applicationId] }),
        qc.invalidateQueries({ queryKey: ["applications", authUser?.uid] }),
      ]);
      toast({ title: "Saved", description: "Updated LaTeX saved to this tailored resume." });
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message ?? "Could not save changes.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleAiAssist = async () => {
    if (!applicationId) return;
    const prompt = aiPrompt.trim();
    if (!prompt) {
      toast({ title: "Enter a prompt", description: "Tell AI what to change in the resume." });
      return;
    }

    try {
      setAiLoading(true);
      const result = await aiAssistTailoredLatex({ applicationId, prompt, latex: draftLatex });
      setDraftLatex(result.latex);
      setAiPrompt("");
      toast({
        title: "AI update ready",
        description: `Applied AI suggestion using ${result.model}. Review and save when you're happy.`,
      });
    } catch (e: any) {
      toast({ title: "AI assist failed", description: e?.message ?? "Could not update the resume.", variant: "destructive" });
    } finally {
      setAiLoading(false);
    }
  };

  const handleReset = () => {
    setDraftLatex(savedLatex);
    toast({ title: "Reset", description: "Restored the last saved LaTeX version." });
  };

  const handleEditorKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const target = e.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const next = `${draftLatex.slice(0, start)}  ${draftLatex.slice(end)}`;
    setDraftLatex(next);
    requestAnimationFrame(() => {
      target.selectionStart = target.selectionEnd = start + 2;
    });
  };

  const title = jobQuery.data?.title || "Tailored Resume";
  const company = jobQuery.data?.company || "";

  return (
    <AppLayout>
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-5 space-y-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Button variant="ghost" size="sm" className="h-7 px-2 gap-1" onClick={() => navigate("/resume?tab=tailored") }>
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </Button>
              <span>/</span>
              <span>Resume Editor</span>
            </div>
            <h1 className="text-2xl font-bold truncate">{title}{company ? ` — ${company}` : ""}</h1>
            <p className="text-sm text-muted-foreground">
              Edit LaTeX on the left, review live PDF preview on the right, then save back to this tailored resume.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={isDirty ? "secondary" : "default"}>{isDirty ? "Unsaved changes" : "Saved"}</Badge>
            <Button variant="outline" className="gap-2" onClick={() => void refreshPreview()} disabled={previewLoading}>
              {previewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Refresh Preview
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={async () => {
                try {
                  await downloadResumePdf(applicationId);
                } catch (e: any) {
                  toast({ title: "Download failed", description: e?.message ?? "Could not download PDF.", variant: "destructive" });
                }
              }}
              disabled={!savedLatex}
            >
              <Download className="h-4 w-4" /> Download PDF
            </Button>
            <Button className="gap-2" onClick={handleSave} disabled={saving || !isDirty}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
            </Button>
          </div>
        </div>

        {applicationQuery.isLoading ? (
          <Card className="card-elevated p-10 text-center text-sm text-muted-foreground">Loading tailored resume…</Card>
        ) : applicationQuery.error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load this tailored resume</AlertTitle>
            <AlertDescription>{(applicationQuery.error as Error).message}</AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
              <Card className="card-elevated p-0 overflow-hidden min-h-[72vh] flex flex-col">
                <div className="p-4 border-b border-border bg-muted/30">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <FileText className="h-4 w-4" />
                        <span className="font-semibold">LaTeX Source</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Autosaves are off. Preview refreshes automatically about 1 second after you stop typing.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>Generated: {formatTs(savedGeneratedAt)}</span>
                      <span>•</span>
                      <span>Last edited: {formatTs(savedEditedAt || applicationQuery.data?.data.updatedAt)}</span>
                    </div>
                  </div>
                </div>

                <div className="p-4 border-b border-border bg-background/70">
                  <div className="grid gap-3 md:grid-cols-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">Role</Label>
                      <div className="text-sm font-medium mt-1">{title}</div>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Company</Label>
                      <div className="text-sm font-medium mt-1">{company || "—"}</div>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">Master Profile</Label>
                      <div className="text-sm font-medium mt-1">
                        {profileQuery.data?.headline || profileQuery.data?.summary?.slice(0, 40) || "Linked"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex-1 p-4">
                  <Textarea
                    value={draftLatex}
                    onChange={(e) => setDraftLatex(e.target.value)}
                    onKeyDown={handleEditorKeyDown}
                    spellCheck={false}
                    className="h-full min-h-[420px] resize-none border-0 shadow-none focus-visible:ring-0 rounded-none bg-transparent font-mono text-[13px] leading-6"
                    placeholder="Your LaTeX resume will appear here..."
                  />
                </div>

                <Separator />

                <div className="p-4 bg-muted/20 space-y-3">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4" />
                    <span className="font-semibold text-sm">AI Assist</span>
                    <Badge variant="secondary">Groq</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Ask AI to rewrite bullets, emphasize a stack, shorten sections, improve ATS relevance, or retarget the resume to this role.
                  </p>
                  <div className="flex flex-col gap-3 lg:flex-row">
                    <Input
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      placeholder="e.g. Make projects more backend focused and shorten the summary to 2 lines"
                      className="flex-1"
                    />
                    <div className="flex gap-2">
                      <Button variant="outline" className="gap-2" onClick={handleReset} disabled={!isDirty || saving || aiLoading}>
                        <Undo2 className="h-4 w-4" /> Reset
                      </Button>
                      <Button className="gap-2" onClick={handleAiAssist} disabled={aiLoading || !draftLatex.trim()}>
                        {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Apply AI
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>

              <Card className="card-elevated p-0 overflow-hidden min-h-[72vh] flex flex-col">
                <div className="p-4 border-b border-border flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Eye className="h-4 w-4" />
                      <span className="font-semibold">Live Preview</span>
                    </div>
                    <p className="text-xs text-muted-foreground">Compiled PDF preview of the current editor content.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => navigator.clipboard.writeText(draftLatex).then(() => toast({ title: "Copied" })).catch(() => void 0)}
                    >
                      <Copy className="h-3.5 w-3.5" /> Copy
                    </Button>
                    <Button variant="outline" size="sm" className="gap-2" asChild>
                      <Link to="/resume?tab=tailored">
                        <FileText className="h-3.5 w-3.5" /> Tailored List
                      </Link>
                    </Button>
                  </div>
                </div>

                <div className="flex-1 bg-muted/30 p-4 space-y-3">
                  {previewError ? (
                    <Alert variant="destructive">
                      <AlertTitle>Preview compile error</AlertTitle>
                      <AlertDescription>
                        <div className="max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5">{previewError}</div>
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  <div className="rounded-xl border border-border bg-background overflow-hidden min-h-[58vh] relative">
                    {previewLoading ? (
                      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center gap-3">
                        <Loader2 className="h-8 w-8 animate-spin text-primary" />
                        <p className="text-sm text-muted-foreground">Compiling preview…</p>
                      </div>
                    ) : null}

                    {previewUrl ? (
                      <iframe title="LaTeX PDF preview" src={previewUrl} className="w-full h-[58vh] bg-white" />
                    ) : (
                      <div className="h-[58vh] flex items-center justify-center text-sm text-muted-foreground px-6 text-center">
                        Start editing the LaTeX source to see the preview here.
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
