import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Check, Sparkles, Loader2, ExternalLink, CreditCard } from "lucide-react";
import { toast } from "sonner";

const STANDARD_PRICE = 50;
const PROMO_PRICE = 10;

const Billing = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);

  // Honour the checkout-result query param from Stripe redirect
  useEffect(() => {
    const status = searchParams.get("checkout");
    if (status === "success") {
      toast.success("Subscription activated. Welcome to Pro!");
      // Give the webhook a moment to land, then refetch
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["subscription"] }), 1500);
      searchParams.delete("checkout");
      setSearchParams(searchParams, { replace: true });
    } else if (status === "cancelled") {
      toast.info("Subscription not started");
      searchParams.delete("checkout");
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: subscription } = useQuery({
    queryKey: ["subscription", user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      return data;
    },
    enabled: !!user,
  });

  const { data: usage } = useQuery({
    queryKey: ["letter-usage", user?.id],
    queryFn: async () => {
      if (!user) return { letters_this_month: 0 };
      const { data } = await supabase
        .from("letter_usage_current_month")
        .select("letters_this_month")
        .eq("user_id", user.id)
        .maybeSingle();
      return data || { letters_this_month: 0 };
    },
    enabled: !!user,
  });

  const lettersUsed = usage?.letters_this_month ?? 0;
  const lettersPerMonth = subscription?.letters_per_month ?? 20;
  const isPro = subscription?.plan === "pro" &&
    (subscription?.status === "active" || subscription?.status === "trialing");

  const handleSubscribe = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-checkout-session");
      if (error) throw new Error(error.message);
      if (data?.not_configured) {
        toast.error("Billing isn't set up yet. Please try again shortly.");
        return;
      }
      if (data?.error) throw new Error(data.error);
      if (data?.url) {
        window.location.href = data.url;
      }
    } catch (err: any) {
      toast.error(err.message || "Could not start checkout");
    } finally {
      setLoading(false);
    }
  };

  const handleManage = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("create-portal-session");
      if (error) throw new Error(error.message);
      if (data?.not_configured) {
        toast.error("Billing isn't set up yet. Please try again shortly.");
        return;
      }
      if (data?.error) throw new Error(data.error);
      if (data?.url) {
        window.location.href = data.url;
      }
    } catch (err: any) {
      toast.error(err.message || "Could not open billing portal");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="px-1 pt-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Your subscription and monthly usage
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {/* Current usage */}
        <Card className="rounded-2xl border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)]">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span>Current Usage</span>
              <Badge
                variant="secondary"
                className={isPro ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}
              >
                {isPro ? "Pro" : "Free"}
              </Badge>
            </CardTitle>
            <CardDescription>
              Letters generated this month
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-3xl font-bold tracking-tight text-foreground">
                  {lettersUsed}
                </span>
                <span className="text-sm text-muted-foreground">
                  of {isPro ? "unlimited" : lettersPerMonth}
                </span>
              </div>
              {!isPro && (
                <Progress
                  value={Math.min((lettersUsed / lettersPerMonth) * 100, 100)}
                  className="h-2"
                />
              )}
            </div>

            {subscription?.current_period_end && (
              <p className="text-xs text-muted-foreground">
                Current period ends{" "}
                {new Date(subscription.current_period_end).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </p>
            )}

            {isPro ? (
              <Button onClick={handleManage} disabled={loading} variant="outline" className="gap-2 w-full">
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CreditCard className="h-4 w-4" />
                )}
                Manage Subscription
                <ExternalLink className="h-3.5 w-3.5 opacity-60" />
              </Button>
            ) : lettersUsed >= lettersPerMonth ? (
              <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-3 text-xs text-amber-900 dark:text-amber-200">
                You've used all {lettersPerMonth} free letters this month. Upgrade to Pro for
                unlimited letters.
              </div>
            ) : (
              <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                {lettersPerMonth - lettersUsed} letters remaining this month.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pro plan */}
        {!isPro && (
          <Card className="rounded-2xl border-primary/30 shadow-[0_1px_3px_rgba(21,33,52,0.04)] bg-gradient-to-br from-primary/5 to-accent/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                NoteMD Pro
              </CardTitle>
              <CardDescription>Unlimited letters and full feature access</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-bold tracking-tight text-foreground">
                  £{PROMO_PRICE}
                </span>
                <span className="text-base text-muted-foreground line-through">
                  £{STANDARD_PRICE}
                </span>
                <span className="text-sm text-muted-foreground">/ month</span>
              </div>
              <Badge variant="secondary" className="bg-accent/15 text-accent">
                Promotional launch price
              </Badge>

              <ul className="space-y-2 text-sm">
                <li className="flex items-start gap-2">
                  <Check className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  Unlimited clinical letters per month
                </li>
                <li className="flex items-start gap-2">
                  <Check className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  Both transcription engines (fast + medical-accurate)
                </li>
                <li className="flex items-start gap-2">
                  <Check className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  Custom letter templates
                </li>
                <li className="flex items-start gap-2">
                  <Check className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  Secretary access + email delivery
                </li>
                <li className="flex items-start gap-2">
                  <Check className="h-4 w-4 text-success mt-0.5 shrink-0" />
                  Audio review for every recording
                </li>
              </ul>

              <Button onClick={handleSubscribe} disabled={loading} className="w-full gap-2 h-11">
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Upgrade to Pro
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Cancel any time. Billed monthly via Stripe.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default Billing;
