import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "stripe-signature, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY");
  const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!STRIPE_SECRET || !WEBHOOK_SECRET) {
    return new Response("Stripe not configured", { status: 503 });
  }

  const stripe = new Stripe(STRIPE_SECRET, {
    apiVersion: "2023-10-16",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return new Response("Bad signature", { status: 400 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  async function syncSubscription(subscription: Stripe.Subscription) {
    const customerId = typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;

    const { data: profile } = await admin
      .from("profiles")
      .select("user_id")
      .eq("stripe_customer_id", customerId)
      .single();
    if (!profile) {
      console.warn(`[stripe-webhook] No profile for customer ${customerId}`);
      return;
    }

    const status = subscription.status;
    const isActive = status === "active" || status === "trialing";
    const plan = isActive ? "pro" : "free";
    const lettersPerMonth = plan === "pro" ? 9999 : 20;

    await admin.from("subscriptions").upsert({
      user_id: profile.user_id,
      stripe_subscription_id: subscription.id,
      status,
      plan,
      letters_per_month: lettersPerMonth,
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    }, { onConflict: "user_id" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.subscription) {
          const subId = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          await syncSubscription(sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(event.data.object as Stripe.Subscription);
        break;
      default:
        // ignore other events
        break;
    }
  } catch (e) {
    console.error("[stripe-webhook] Handler error:", e);
    return new Response("Handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
