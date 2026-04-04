import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Sparkles, RefreshCw, BrainCircuit, CheckCircle2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { generateAiTejaskritRecommendations } from "@/lib/api";
import { getRecommendationMeta } from "@/lib/firestore";
import { useAuth } from "@/contexts/AuthProvider";
import { toast } from "@/hooks/use-toast";

type Props = {
  hasRecommendations: boolean;
  generatedAtLabel?: string;
  compact?: boolean;
};

const STAGE_LABELS: Record<string, string> = {
  idle: "Waiting to start",
  loading_jobs: "Collecting your visible jobs",
  local_scoring: "Scoring every visible job",
  ai_scoring: "Tejaskrit AI is ranking your jobs",
  saving: "Saving the final recommendation bundle",
  ready: "Recommendations saved",
  failed: "Recommendation generation failed",
};

const FALLBACK_STAGES = [
  { until: 18, label: STAGE_LABELS.loading_jobs },
  { until: 42, label: STAGE_LABELS.local_scoring },
  { until: 80, label: STAGE_LABELS.ai_scoring },
  { until: 95, label: STAGE_LABELS.saving },
  { until: 100, label: "Almost done" },
];

export function AiRecommendationButton({ hasRecommendations, generatedAtLabel, compact = false }: Props) {
  const qc = useQueryClient();
  const { authUser } = useAuth();
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState(FALLBACK_STAGES[0]!.label);

  const metaQuery = useQuery({
    queryKey: ["recommendationMeta", authUser?.uid],
    enabled: open && !!authUser?.uid,
    queryFn: () => getRecommendationMeta(authUser!.uid),
    refetchInterval: open ? 900 : false,
    staleTime: 0,
  });

  const mutation = useMutation({
    mutationFn: generateAiTejaskritRecommendations,
    onMutate: () => {
      setProgress(6);
      setProgressLabel(STAGE_LABELS.loading_jobs);
      setOpen(true);
    },
    onSuccess: (data) => {
      setProgress(100);
      setProgressLabel(STAGE_LABELS.ready);
      toast({
        title: hasRecommendations ? "Recommendations regenerated" : "Recommendations ready",
        description: `${data.recommendationCount} ranked jobs are now saved to your profile.`,
      });
      Promise.all([
        qc.invalidateQueries({ queryKey: ["activeRecommendationBundle"] }),
        qc.invalidateQueries({ queryKey: ["activeRecommendations"] }),
        qc.invalidateQueries({ queryKey: ["recommendationMeta"] }),
        qc.invalidateQueries({ queryKey: ["recommendedJobs"] }),
        qc.invalidateQueries({ queryKey: ["jobsFeed"] }),
        qc.invalidateQueries({ queryKey: ["homeFallbackJobs"] }),
        qc.invalidateQueries({ queryKey: ["instituteJobs"] }),
      ]).finally(() => {
        window.setTimeout(() => setOpen(false), 900);
      });
    },
    onError: (e: any) => {
      toast({
        title: "Recommendation generation failed",
        description: e?.message ?? "Please try again in a moment.",
        variant: "destructive",
      });
      setProgress(0);
      setProgressLabel(STAGE_LABELS.failed);
      setOpen(false);
    },
  });

  useEffect(() => {
    const meta = metaQuery.data;
    if (!open || !meta) return;
    if (typeof meta.progressPercent === "number") setProgress(Math.max(progress, meta.progressPercent));
    if (meta.stage) setProgressLabel(STAGE_LABELS[meta.stage] ?? progressLabel);
  }, [metaQuery.data, open, progress, progressLabel]);

  useEffect(() => {
    if (!mutation.isPending || metaQuery.data?.stage) return;
    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 90) return current;
        const delta = current < 28 ? 6 : current < 58 ? 4 : 2;
        return Math.min(90, current + delta);
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [mutation.isPending, metaQuery.data?.stage]);

  const currentLabel = useMemo(() => {
    if (progressLabel) return progressLabel;
    const match = FALLBACK_STAGES.find((stage) => progress <= stage.until);
    return match?.label ?? FALLBACK_STAGES[FALLBACK_STAGES.length - 1]!.label;
  }, [progress, progressLabel]);

  return (
    <>
      <Card className={`border-primary/20 bg-gradient-to-r from-primary/10 via-background to-background ${compact ? "p-3" : "p-4"}`}>
        <div className={`flex ${compact ? "flex-col gap-3" : "flex-col md:flex-row md:items-center md:justify-between gap-4"}`}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-primary mb-1">
              <Sparkles className="h-4 w-4" />
              <p className="text-sm font-semibold">AI Tejaskrit Recommendation</p>
            </div>
            <p className="text-sm text-muted-foreground">
              {hasRecommendations
                ? `Your saved AI-ranked jobs load instantly until you regenerate them.${generatedAtLabel ? ` Last updated ${generatedAtLabel}.` : ""}`
                : "Generate personalized job recommendations from your master resume and save them to Firebase for future visits."}
            </p>
          </div>
          <Button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="gap-2 shadow-sm shadow-primary/20"
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : hasRecommendations ? <RefreshCw className="h-4 w-4" /> : <BrainCircuit className="h-4 w-4" />}
            {mutation.isPending ? "Generating…" : hasRecommendations ? "Regenerate Recommendation" : "Generate Recommendation"}
          </Button>
        </div>
      </Card>

      <Dialog open={open} onOpenChange={(next) => (!mutation.isPending ? setOpen(next) : undefined)}>
        <DialogContent className="sm:max-w-md overflow-hidden">
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary/40 via-primary to-primary/40"
          />
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {progress >= 100 ? <CheckCircle2 className="h-5 w-5 text-green-600" /> : <Sparkles className="h-5 w-5 text-primary" />}
              AI Tejaskrit Recommendation
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5 pt-2">
            <div className="rounded-2xl border bg-muted/30 p-4">
              <div className="flex items-center justify-between text-sm mb-3">
                <span className="font-medium">{currentLabel}</span>
                <span className="text-muted-foreground">{Math.round(progress)}%</span>
              </div>
              <Progress value={progress} className="h-3" />
              <p className="text-xs text-muted-foreground mt-3">
                We are scoring your visible jobs, saving one exact recommendation bundle, and keeping that order stable until you regenerate it.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3 text-center text-xs">
              {[
                { title: "Jobs", subtitle: "Collect" },
                { title: "AI", subtitle: "Rank" },
                { title: "Bundle", subtitle: "Save" },
              ].map((item, idx) => (
                <motion.div
                  key={item.title}
                  animate={{ y: mutation.isPending ? [0, -5, 0] : 0, opacity: 1 }}
                  transition={{ repeat: mutation.isPending ? Infinity : 0, duration: 1.2, delay: idx * 0.12 }}
                  className="rounded-xl border bg-background p-3"
                >
                  <p className="font-semibold">{item.title}</p>
                  <p className="text-muted-foreground mt-1">{item.subtitle}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
