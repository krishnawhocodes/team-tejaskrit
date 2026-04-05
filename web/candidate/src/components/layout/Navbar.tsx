import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Search, Bell, Command } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProfileDropdown } from "./ProfileDropdown";
import { CommandPalette } from "./CommandPalette";
import { useAuth } from "@/contexts/AuthProvider";
import { useQuery } from "@tanstack/react-query";
import { listUserNotifications } from "@/lib/firestore";

const navItems = [
  { label: "Dashboard", path: "/" },
  { label: "Jobs", path: "/jobs" },
  { label: "Tracker", path: "/tracker" },
  { label: "Analytics", path: "/analytics" },
  { label: "Resume", path: "/resume" },
  { label: "Extension", path: "/extension" },
  { label: "Notifications", path: "/notifications" },
];

export function Navbar() {
  const location = useLocation();
  const [commandOpen, setCommandOpen] = useState(false);
  const { authUser } = useAuth();

  const { data: notifs } = useQuery({
    queryKey: ["notifications", authUser?.uid],
    enabled: !!authUser?.uid,
    queryFn: async () => {
      if (!authUser?.uid) return [];
      return await listUserNotifications(authUser.uid, 50);
    },
    staleTime: 30_000,
  });

  const unreadCount = useMemo(() => (notifs ?? []).filter((n) => !n.data.read).length, [notifs]);

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-50 h-14 bg-card border-b border-border">
        <div className="max-w-[1300px] mx-auto h-full px-4 sm:px-6 flex items-center gap-6">
          {/* Logo */}
          <Link
            to="/"
            className="text-lg font-bold tracking-wide text-foreground shrink-0"
            style={{ letterSpacing: "0.08em" }}
          >
            Tejaskrit
          </Link>

          {/* Nav Links — hidden on mobile */}
          <nav className="hidden md:flex items-center gap-1 flex-1">
            {navItems.map((item) => {
              const isActive = item.path === "/" ? location.pathname === "/" : location.pathname.startsWith(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Right side */}
          <div className="flex items-center gap-2 ml-auto">
            <Button
              variant="outline"
              size="sm"
              className="hidden sm:flex items-center gap-2 text-muted-foreground h-8 w-56 justify-start"
              onClick={() => setCommandOpen(true)}
            >
              <Search className="h-3.5 w-3.5" />
              <span className="text-xs">Search...</span>
              <kbd className="ml-auto pointer-events-none hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
                <Command className="h-2.5 w-2.5" />K
              </kbd>
            </Button>

            <Link to="/notifications">
              <Button variant="ghost" size="icon" className="relative h-8 w-8">
                <Bell className="h-4 w-4" />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                    {unreadCount}
                  </span>
                )}
              </Button>
            </Link>

            <ProfileDropdown />
          </div>
        </div>
      </header>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 h-14 bg-card border-t border-border flex items-center justify-around px-2">
        {navItems.slice(0, 5).map((item) => {
          const isActive = item.path === "/" ? location.pathname === "/" : location.pathname.startsWith(item.path);
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                isActive ? "text-primary" : "text-muted-foreground"
              }`}
            >
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </>
  );
}
