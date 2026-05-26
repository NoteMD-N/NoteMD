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
  default: "text-primary bg-primary/10",
  accent: "text-accent bg-accent/10",
  success: "text-success bg-success/10",
  warning: "text-warning bg-warning/10",
};

export function SummaryCard({
  title,
  value,
  icon: Icon,
  variant = "default",
  subtitle,
}: SummaryCardProps) {
  return (
    <div className="bento-card-sm flex items-start justify-between">
      <div className="space-y-2">
        <p className="text-[13px] font-medium text-muted-foreground">{title}</p>
        <div className="flex items-baseline gap-1.5">
          <p className="text-2xl font-bold tracking-tight text-foreground">{value}</p>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      <div className={cn("rounded-xl p-2.5", iconStyles[variant])}>
        <Icon className="h-5 w-5" />
      </div>
    </div>
  );
}

export default SummaryCard;
