-- =============================================================================
-- Sprint action-plan schema (June 2026)
-- - Clinician profile: role title + hospital/organisation + dictation engine pref
-- - Subscription tracking for Stripe billing + monthly letter quota gating
-- =============================================================================

-- Clinician profile fields ---------------------------------------------------
-- Free-text role title (e.g. "Consultant Neurologist", "GP", "Specialist Nurse")
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role_title text;

-- Hospital / organisation name (appears in letter signature when set)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS hospital_organisation text;

-- Preferred dictation engine: 'fast' (Deepgram, live) | 'accurate' (medical ASR, batch)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS dictation_engine text NOT NULL DEFAULT 'accurate'
    CHECK (dictation_engine IN ('fast', 'accurate'));

-- Stripe / billing -----------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id text UNIQUE;

-- Per-clinician subscription state. Pricing/plan logic lives in Stripe; we mirror
-- just enough state here to gate access quickly without a Stripe API round-trip.
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_subscription_id text UNIQUE,
  status text NOT NULL DEFAULT 'inactive'
    CHECK (status IN ('inactive', 'trialing', 'active', 'past_due', 'canceled')),
  plan text NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'pro')),
  current_period_end timestamptz,
  letters_per_month integer NOT NULL DEFAULT 20,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own subscription"
  ON public.subscriptions FOR SELECT
  USING (user_id = auth.uid());

-- Inserts/updates only via service-role (Stripe webhook) — no policy for the client.

CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-seed a free-tier subscription row on signup
CREATE OR REPLACE FUNCTION public.handle_new_subscription()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.subscriptions (user_id, plan, status, letters_per_month)
  VALUES (NEW.id, 'free', 'active', 20)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created_subscription ON auth.users;
CREATE TRIGGER on_auth_user_created_subscription
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_subscription();

-- Back-fill existing users
INSERT INTO public.subscriptions (user_id, plan, status, letters_per_month)
SELECT id, 'free', 'active', 20
FROM auth.users
WHERE id NOT IN (SELECT user_id FROM public.subscriptions);

-- Letter usage view (current calendar month) — used for quota gating ---------
CREATE OR REPLACE VIEW public.letter_usage_current_month
WITH (security_invoker = true) AS
SELECT
  user_id,
  count(*)::integer AS letters_this_month
FROM public.letters
WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
GROUP BY user_id;

GRANT SELECT ON public.letter_usage_current_month TO authenticated;
