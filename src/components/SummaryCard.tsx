import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface SummaryCardProps {
  title: string;
  value: number | string;
  icon: LucideIcon;
  variant?: "default" | "accent" | "success" | "warning";
  subtitle?: string;
}

const iconStyles = {
  default: "text-primary bg-primary/10 ring-primary/20",
  accent: "text-accent bg-accent/10 ring-accent/20",
  success: "text-success bg-success/10 ring-success/20",
  warning: "text-warning bg-warning/10 ring-warning/20",
};

const numericAccent = {
  default: "text-foreground",
  accent: "text-foreground",
  success: "text-foreground",
  warning: "text-foreground",
};

export function SummaryCard({
  title,
  value,
  icon: Icon,
  variant = "default",
  subtitle,
}: SummaryCardProps) {
  return (
    <div className="group relative overflow-hidden bento-card-sm flex items-start justify-between transition-all hover:shadow-md hover:-translate-y-0.5">
      {/* Subtle gradient accent on hover */}
      <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br from-transparent via-transparent to-primary/5" />
      <div className="relative space-y-2">
        <p className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
        <div className="flex items-baseline gap-1.5">
          <p className={cn("font-heading text-3xl font-bold tracking-tight tabular-nums", numericAccent[variant])}>
            {value}
          </p>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      <div className={cn("relative rounded-xl p-2.5 ring-1", iconStyles[variant])}>
        <Icon className="h-5 w-5" />
      </div>
    </div>
  );
}

export default SummaryCard;
