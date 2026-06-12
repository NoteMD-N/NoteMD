-- Some users (founders, internal testers, comp accounts) should never be quota-gated
-- regardless of subscription state. This flag is the clean way to express that.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS quota_exempt boolean NOT NULL DEFAULT false;
