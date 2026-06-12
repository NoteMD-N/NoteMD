import { Outlet, useLocation, Link, useNavigate } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Mic } from "lucide-react";
import AppSidebar from "@/components/AppSidebar";
import { BrandMark } from "@/components/BrandLogo";

const routeLabels: Record<string, string> = {
  dashboard: "Dashboard",
  recordings: "Recordings",
  letters: "Letters",
  record: "New Recording",
  letter: "Letter",
  templates: "Templates",
  settings: "Settings",
  billing: "Billing",
};

const AppLayout = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const segments = location.pathname.split("/").filter(Boolean);

  const breadcrumbs = segments.map((seg, i) => {
    const path = "/" + segments.slice(0, i + 1).join("/");
    const label = routeLabels[seg] || seg.slice(0, 8);
    const isLast = i === segments.length - 1;
    return { path, label, isLast };
  });

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <AppSidebar />
        {/* Content column — floating layout with breathing room */}
        <div className="flex min-w-0 flex-1 flex-col gap-2 py-2 pr-2 sm:pr-3 pl-2 sm:pl-3">
          {/* Floating header bar */}
          <header className="flex h-14 shrink-0 items-center gap-2 sm:gap-3 rounded-2xl border border-border/60 bg-card px-3 sm:px-4 shadow-[0_1px_3px_rgba(21,33,52,0.04)] min-w-0">
            <SidebarTrigger className="-ml-1 shrink-0" />
            <Link
              to="/dashboard"
              className="flex items-center gap-2 hover:opacity-80 transition-opacity shrink-0"
              title="NoteMD home"
            >
              <BrandMark className="h-7 w-7" />
              <span className="font-heading text-sm font-bold tracking-tight text-foreground hidden sm:inline">
                NoteMD
              </span>
            </Link>
            <div className="h-5 w-px bg-border/60 hidden sm:block shrink-0" />
            <Breadcrumb className="flex-1 min-w-0 overflow-hidden">
              <BreadcrumbList>
                {breadcrumbs.map((crumb, i) => (
                  <span key={crumb.path} className="flex items-center gap-1.5">
                    {i > 0 && <BreadcrumbSeparator />}
                    <BreadcrumbItem>
                      {crumb.isLast ? (
                        <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <Link to={crumb.path}>{crumb.label}</Link>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </span>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
            <Button onClick={() => navigate("/record")} size="sm" className="gap-2 rounded-xl shrink-0">
              <Mic className="h-4 w-4" />
              <span className="hidden sm:inline">New Recording</span>
            </Button>
          </header>

          {/* Page content */}
          <main className="flex-1 overflow-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
};

export default AppLayout;
