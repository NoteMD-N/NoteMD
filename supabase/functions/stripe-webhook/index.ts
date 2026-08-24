import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { corsHeaders } from "../_shared/cors.ts";

// Pull current_period_end across Stripe API versions:
//   - Older (<= 2024-04): subscription.current_period_end (number, seconds)
//   - Newer (>= 2025-12 with subscription schedules): subscription.items.data[0].current_period_end
// Returns ISO string or null if it can't be derived.
function getPeriodEndIso(subscription: any): string | null {
  const top = subscription?.current_period_end;
  const item = subscription?.items?.data?.[0]?.current_period_end;
  const epoch = typeof top === "number" ? top : typeof item === "number" ? item : null;
  if (!epoch) return null;
  try {
    return new Date(epoch * 1000).toISOString();
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ALWAYS return 200 to Stripe unless we genuinely can't process — Stripe will retry
  // on any non-2xx, and a buggy event handler shouldn't cause a retry storm. We log
  // internal errors and acknowledge so Stripe stops retrying.
  const ack = () =>
    new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });

  const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
  const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!STRIPE_SECRET || !WEBHOOK_SECRET) {
    console.error("[stripe-webhook] Not configured (missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET)");
    return new Response("Stripe not configured", { status: 503 });
  }

  let stripe: Stripe;
  try {
    stripe = new Stripe(STRIPE_SECRET, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });
  } catch (e) {
    console.error("[stripe-webhook] Stripe SDK init failed:", e);
    return ack(); // ack to avoid retry storms
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    console.warn("[stripe-webhook] Missing signature header");
    return new Response("Missing signature", { status: 400 });
  }

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return new Response("Bad signature", { status: 400 });
  }

  console.log(`[stripe-webhook] Event: ${event.type} (id=${event.id})`);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  async function syncSubscription(subscription: Stripe.Subscription) {
    try {
      const customerId = typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;

      const { data: profile, error: profileErr } = await admin
        .from("profiles")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();

      if (profileErr) {
        console.error(`[stripe-webhook] Profile lookup error for ${customerId}:`, profileErr);
        return;
      }
      if (!profile) {
        console.warn(`[stripe-webhook] No profile for customer ${customerId} — skipping`);
        return;
      }

      const status = subscription.status;
      const isActive = status === "active" || status === "trialing";
      const plan = isActive ? "pro" : "free";
      const lettersPerMonth = plan === "pro" ? 9999 : 20;

      const periodEndIso = getPeriodEndIso(subscription);

      const payload: Record<string, unknown> = {
        user_id: profile.user_id,
        stripe_subscription_id: subscription.id,
        status,
        plan,
        letters_per_month: lettersPerMonth,
      };
      if (periodEndIso) payload.current_period_end = periodEndIso;

      const { error: upsertErr } = await admin
        .from("subscriptions")
        .upsert(payload, { onConflict: "user_id" });
      if (upsertErr) {
        console.error("[stripe-webhook] Subscription upsert failed:", upsertErr);
      } else {
        console.log(`[stripe-webhook] Synced ${subscription.id} for ${profile.user_id}: plan=${plan} status=${status}`);
      }
    } catch (e) {
      console.error("[stripe-webhook] syncSubscription threw:", e);
    }
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.subscription) {
          const subId = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
          try {
            const sub = await stripe.subscriptions.retrieve(subId);
            await syncSubscription(sub);
          } catch (e) {
            console.error(`[stripe-webhook] Failed to retrieve subscription ${subId}:`, e);
          }
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(event.data.object as Stripe.Subscription);
        break;
      default:
        // Ignore other events but still ack
        break;
    }
  } catch (e) {
    // Last-resort catch — log and ack so Stripe stops retrying.
    console.error(`[stripe-webhook] Top-level handler error for ${event.type}:`, e);
  }

  return ack();
});
