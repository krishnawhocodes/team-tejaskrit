import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Briefcase,
  FileText,
  LayoutDashboard,
  Search,
  Bell,
  BarChart3
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useAuth } from "@/contexts/AuthProvider";
import { useQuery } from "@tanstack/react-query";
import { getJobsByIds, jobIdFromAny, listRecommendations, listPublicJobs } from "@/lib/firestore";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const { authUser } = useAuth();

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, onOpenChange]);

  const go = (path: string) => {
    navigate(path);
    onOpenChange(false);
  };

  const { data: topJobs } = useQuery({
    queryKey: ["commandTopJobs", authUser?.uid],
    enabled: !!authUser?.uid,
    queryFn: async () => {
      if (!authUser?.uid) return [];
      const recs = await listRecommendations(authUser.uid, 5);
      if (recs.length > 0) {
        const ids = recs.map((r) => jobIdFromAny(r.data.jobId ?? r.id));
        const map = await getJobsByIds(ids);
        return recs
          .map((r) => {
            const id = jobIdFromAny(r.data.jobId ?? r.id);
            return {
              id,
              title: map[id]?.title ?? "(Job)",
              company: map[id]?.company ?? "",
              score: r.data.score,
            };
          })
          .filter((x) => x.title);
      }

      // fallback: latest public jobs
      const jobs = await listPublicJobs(5);
      return jobs.map((j) => ({ id: j.id, title: j.data.title, company: j.data.company, score: 0 }));
    },
    staleTime: 60_000,
  });

  const items = useMemo(() => topJobs ?? [], [topJobs]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search pages..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Pages">
          <CommandItem onSelect={() => go("/")}>
            <LayoutDashboard className="mr-2 h-4 w-4" /> Dashboard
          </CommandItem>
          <CommandItem onSelect={() => go("/jobs")}>
            <Briefcase className="mr-2 h-4 w-4" /> Jobs
          </CommandItem>
          <CommandItem onSelect={() => go("/tracker")}>
            <Search className="mr-2 h-4 w-4" /> Tracker
          </CommandItem>
          <CommandItem onSelect={() => go("/analytics")}>
            <BarChart3 className="mr-2 h-4 w-4" /> Analytics
          </CommandItem>
          <CommandItem onSelect={() => go("/resume")}>
            <FileText className="mr-2 h-4 w-4" /> Resume
          </CommandItem>
          <CommandItem onSelect={() => go("/notifications")}>
            <Bell className="mr-2 h-4 w-4" /> Notifications
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading="Top Jobs">
          {items.map((job) => (
            <CommandItem key={job.id} onSelect={() => go("/jobs")}>
              <Briefcase className="mr-2 h-4 w-4" />
              {job.title} — {job.company}
              {job.score ? (
                <span className="ml-auto text-xs text-muted-foreground">
                  {job.score}%
                </span>
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
