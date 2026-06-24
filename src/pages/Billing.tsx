import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Check,
  Sparkles,
  Loader2,
  ExternalLink,
  CreditCard,
  CheckCircle2,
  Repeat,
  XCircle,
  CalendarClock,
} from "lucide-react";
import { toast } from "sonner";

const STANDARD_PRICE = 50;
const PROMO_PRICE = 10;

const Billing = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  // Track whether the user just returned from Stripe Checkout successfully — used
  // to show a prominent confirmation card (Mohamed reported the previous toast
  // wasn't visible enough).
  const [justSubscribed, setJustSubscribed] = useState(false);

  useEffect(() => {
    const status = searchParams.get("checkout");
    if (status === "success") {
      setJustSubscribed(true);
      // Webhook usually lands within a couple of seconds; refetch a few times to
      // catch the state change as soon as it's there.
      const refetch = () => queryClient.invalidateQueries({ queryKey: ["subscription"] });
      refetch();
      const t1 = setTimeout(refetch, 2000);
      const t2 = setTimeout(refetch, 6000);
      const t3 = setTimeout(refetch, 12000);
      searchParams.delete("checkout");
      setSearchParams(searchParams, { replace: true });
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }
    if (status === "cancelled") {
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

  const formatDate = (d: string | null | undefined) =>
    d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "—";

  return (
    <div className="space-y-3">
      <div className="px-1 pt-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Your subscription and monthly usage
        </p>
      </div>

      {/* Post-checkout success confirmation — visible card so the user knows the
          payment landed without having to spot a toast. */}
      {justSubscribed && (
        <Card className="rounded-2xl border-success/30 bg-gradient-to-br from-success/10 to-success/5 shadow-[0_1px_3px_rgba(21,33,52,0.04)]">
          <CardContent className="flex items-start gap-3 py-5">
            <div className="rounded-xl bg-success/15 p-2.5">
              <CheckCircle2 className="h-5 w-5 text-success" />
            </div>
            <div className="flex-1">
              <p className="font-heading text-base font-semibold text-foreground">
                Payment successful — welcome to NoteMD Pro
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Your subscription is being activated. The status below will update within a few seconds.
                You can manage or cancel at any time from this page.
              </p>
            </div>
            <button
              onClick={() => setJustSubscribed(false)}
              className="text-muted-foreground hover:text-foreground p-1"
              aria-label="Dismiss"
            >
              <XCircle className="h-4 w-4" />
            </button>
          </CardContent>
        </Card>
      )}

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

            {isPro && subscription?.current_period_end && (
              <div className="rounded-lg bg-muted/40 p-3 space-y-1.5 text-xs">
                <div className="flex items-center gap-1.5 text-foreground font-medium">
                  <CalendarClock className="h-3.5 w-3.5" />
                  Next billing date
                </div>
                <p className="text-muted-foreground">
                  {formatDate(subscription.current_period_end)} — £{PROMO_PRICE} will be charged
                  to your card on file. Cancel any time before this date to avoid the next charge.
                </p>
              </div>
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

        {/* Pro plan — only show the upsell when the user isn't already Pro */}
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
              <div>
                <div className="flex items-baseline gap-3">
                  <span className="text-3xl font-bold tracking-tight text-foreground">
                    £{PROMO_PRICE}
                  </span>
                  <span className="text-base text-muted-foreground line-through">
                    £{STANDARD_PRICE}
                  </span>
                  <span className="text-sm text-muted-foreground">/ month</span>
                </div>
                <Badge variant="secondary" className="mt-2 bg-accent/15 text-accent">
                  Promotional launch price
                </Badge>
              </div>

              {/* Clear billing terms — Mohamed asked for these to be visible */}
              <div className="rounded-lg border border-border/60 bg-card p-3 space-y-2 text-sm">
                <div className="flex items-start gap-2">
                  <Repeat className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-foreground">Billed monthly</p>
                    <p className="text-xs text-muted-foreground">
                      £{PROMO_PRICE} charged on the same day each month until you cancel.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <XCircle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-foreground">Cancel any time</p>
                    <p className="text-xs text-muted-foreground">
                      One click from this page. No contract, no cancellation fee. You'll
                      keep access until the end of the period you've already paid for.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <CreditCard className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-foreground">Secure payment via Stripe</p>
                    <p className="text-xs text-muted-foreground">
                      Card details are handled by Stripe. We never see or store your card.
                    </p>
                  </div>
                </div>
              </div>

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
                Upgrade to Pro — £{PROMO_PRICE}/month
              </Button>
            </CardContent>
          </Card>
        )}

        {/* If the user IS Pro, show the plan summary card on the right with full
            billing terms (so they can re-read them at any time, not just at signup) */}
        {isPro && (
          <Card className="rounded-2xl border-border/60 shadow-[0_1px_3px_rgba(21,33,52,0.04)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                Your Plan
              </CardTitle>
              <CardDescription>NoteMD Pro — monthly subscription</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-foreground">
                  £{PROMO_PRICE}
                </span>
                <span className="text-sm text-muted-foreground">/ month</span>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2 text-sm">
                <div className="flex items-start gap-2">
                  <Repeat className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-foreground">Billed monthly</p>
                    <p className="text-xs text-muted-foreground">
                      Charged automatically each month until cancelled.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <XCircle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-foreground">Cancel any time</p>
                    <p className="text-xs text-muted-foreground">
                      Use "Manage Subscription" to cancel. No fees. You keep access until
                      the end of the current billing period.
                    </p>
                  </div>
                </div>
              </div>
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                <li className="flex items-start gap-2">
                  <Check className="h-3.5 w-3.5 text-success mt-0.5 shrink-0" />
                  Unlimited clinical letters
                </li>
                <li className="flex items-start gap-2">
                  <Check className="h-3.5 w-3.5 text-success mt-0.5 shrink-0" />
                  Both transcription engines
                </li>
                <li className="flex items-start gap-2">
                  <Check className="h-3.5 w-3.5 text-success mt-0.5 shrink-0" />
                  Custom templates, secretary access, email delivery, audio review
                </li>
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default Billing;
