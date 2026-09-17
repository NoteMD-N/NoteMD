-- ===========================================================================
-- Close a cross-tenant privilege escalation in profiles
--
-- Found by src/test/idor.integration.test.ts running against a live database.
--
-- Secretary access is derived at query time from profiles.clinician_id:
--
--   CREATE POLICY "Secretaries can view their clinician's letters"
--     ON public.letters FOR SELECT
--     USING (user_id = public.get_my_clinician_id());
--
--   get_my_clinician_id() = SELECT clinician_id FROM profiles WHERE user_id = auth.uid()
--
-- and profiles carried only:
--
--   CREATE POLICY "Users can update their own profile"
--     ON public.profiles FOR UPDATE USING (auth.uid() = user_id);
--
-- That policy restricts WHICH ROW a user may update, but not WHICH COLUMNS.
-- So any authenticated account could set its own clinician_id to another
-- clinician's user_id and immediately read that clinician's letters,
-- recordings and stored audio — every patient record belonging to them. The
-- same gap let an account set its own role to 'admin'.
--
-- Both were confirmed against staging: one UPDATE, then one of clinician A's
-- letters was readable by an unrelated account.
--
-- Postgres offers column-level UPDATE grants, but they would have to enumerate
-- every safe column and would silently start rejecting writes to any column
-- added later. A trigger states the rule directly instead: these two columns
-- are not self-assignable, everything else on the row still is.
--
-- Legitimate assignment is unaffected — manage-secretary performs it with the
-- service role.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.profiles_guard_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  -- PostgREST puts the caller's JWT claims here. Absent for a direct
  -- connection (migrations, psql), which is why auth.uid() is checked too.
  v_jwt_role text := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  -- The service role is how manage-secretary, migrations and support tooling
  -- legitimately change these. An absent auth.uid() means there is no end-user
  -- session to escalate in the first place.
  IF v_jwt_role = 'service_role' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'profiles.role is not self-assignable'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Role changes are made by an administrator, not by the account.';
  END IF;

  IF NEW.clinician_id IS DISTINCT FROM OLD.clinician_id THEN
    RAISE EXCEPTION 'profiles.clinician_id is not self-assignable'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Secretary assignment is made through manage-secretary, which a clinician authorises.';
  END IF;

  -- user_id identifies the row's owner and is what every other policy keys
  -- off. Rewriting it would move the row to another account.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'profiles.user_id is immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_privileged_columns ON public.profiles;
CREATE TRIGGER profiles_guard_privileged_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_guard_privileged_columns();

-- An INSERT path exists too: "Users can insert their own profile" has a
-- WITH CHECK on user_id only, so a user whose profile row was somehow absent
-- could create one naming a clinician. handle_new_user() creates the row on
-- signup with the service role, so ordinary signup is unaffected.
CREATE OR REPLACE FUNCTION public.profiles_guard_privileged_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_jwt_role text := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  IF v_jwt_role = 'service_role' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.clinician_id IS NOT NULL THEN
    RAISE EXCEPTION 'profiles.clinician_id cannot be set on self-insert'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.role IS NOT NULL AND NEW.role <> 'clinician' THEN
    RAISE EXCEPTION 'profiles.role cannot be chosen on self-insert'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_guard_privileged_insert ON public.profiles;
CREATE TRIGGER profiles_guard_privileged_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_guard_privileged_insert();

COMMENT ON FUNCTION public.profiles_guard_privileged_columns IS
  'Prevents an account from granting itself secretary access to another '
  'clinician, or promoting itself, by writing its own profile row. RLS '
  'restricts which row may be updated but not which columns.';
