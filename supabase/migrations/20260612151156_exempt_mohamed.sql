-- Mark Mohamed (founder/clinician owner) as quota-exempt.

UPDATE public.subscriptions s
SET quota_exempt = true
FROM auth.users u
WHERE s.user_id = u.id
  AND u.email = 'abualapass123@yahoo.com';
