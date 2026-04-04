import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Sparkles, RefreshCw, BrainCircuit, CheckCircle2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { generateAiTejaskritRecommendations } from "@/lib/api";
import { toast } from "@/hooks/use-toast";

type Props = {
  hasRecommendations: boolean;
  generatedAtLabel?: string;
  compact?: boolean;
};

const STAGES = [
  { until: 18, label: "Collecting your visible jobs" },
  { until: 42, label: "Shortlisting the strongest opportunities" },
  { until: 76, label: "Tejaskrit AI is reading your master resume" },
  { until: 94, label: "Saving recommendations to Firebase" },
  { until: 100, label: "Almost done" },
];

export function AiRecommendationButton({ hasRecommendations, generatedAtLabel, compact = false }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState(0);

  const mutation = useMutation({
    mutationFn: generateAiTejaskritRecommendations,
    onMutate: () => {
      setProgress(6);
      setOpen(true);
    },
    onSuccess: (data) => {
      setProgress(100);
      toast({
        title: hasRecommendations ? "Recommendations regenerated" : "Recommendations ready",
        description: `${data.recommendationCount} AI-ranked jobs are now saved to your profile.`,
      });
      Promise.all([
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
      setOpen(false);
      setProgress(0);
    },
  });

  useEffect(() => {
    if (!mutation.isPending) return;
    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 93) return current;
        const delta = current < 28 ? 7 : current < 55 ? 5 : current < 80 ? 3 : 1;
        return Math.min(93, current + delta);
      });
    }, 650);
    return () => window.clearInterval(timer);
  }, [mutation.isPending]);

  const currentLabel = useMemo(() => {
    const match = STAGES.find((stage) => progress <= stage.until);
    return match?.label ?? STAGES[STAGES.length - 1]!.label;
  }, [progress]);

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
                We are shortlisting jobs, scoring them with Tejaskrit AI, and saving the final recommendations to your profile.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3 text-center text-xs">
              {["Jobs", "Resume", "Firebase"].map((item, idx) => (
                <motion.div
                  key={item}
                  animate={{ y: mutation.isPending ? [0, -5, 0] : 0, opacity: 1 }}
                  transition={{ repeat: mutation.isPending ? Infinity : 0, duration: 1.2, delay: idx * 0.12 }}
                  className="rounded-xl border bg-background p-3"
                >
                  <p className="font-semibold">{item}</p>
                  <p className="text-muted-foreground mt-1">{idx === 0 ? "Collect" : idx === 1 ? "Analyze" : "Save"}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
