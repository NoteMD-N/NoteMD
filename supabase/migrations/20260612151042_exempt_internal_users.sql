-- Mark internal / founder accounts as quota-exempt so they're never blocked by the
-- subscription gate even when Stripe is live.
-- Idempotent: safe to re-run, only flips the flag for matching emails.

UPDATE public.subscriptions s
SET quota_exempt = true
FROM auth.users u
WHERE s.user_id = u.id
  AND u.email IN (
    'chris@valoco.co'
    -- Add more internal emails here as needed
  );
