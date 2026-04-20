-- ─────────────────────────────────────────────────────────────────────────────
-- Sync auth.users → public.users
--
-- Supabase owns `auth.users`. Our application schema references a
-- `public.users` row for each account (collection, decks, rips all FK to it).
-- This trigger keeps them in lockstep so signup flows never 404 a FK.
--
-- Behaviour:
--   • On insert into auth.users:    copy id + derived username/displayName/avatar.
--   • On update of auth.users:      refresh displayName/avatarUrl from metadata
--                                   (username stays immutable — collision risk).
--   • On delete of auth.users:      public.users row cascades via ON DELETE
--                                   CASCADE in its FK when we add one.
--
-- Username strategy: prefer metadata.username → email local-part → short uuid
-- prefix. On collision, append the first 6 chars of the uuid. Kept server-side
-- so clients can't collide or race.
--
-- Security: SECURITY DEFINER so the trigger runs as the function owner and
-- can write to public.users even though the insert happens as the auth role.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  base_username text;
  candidate     text;
  suffix        text;
BEGIN
  -- Preferred username sources, in order.
  base_username := COALESCE(
    NEW.raw_user_meta_data ->> 'username',
    NEW.raw_user_meta_data ->> 'preferred_username',
    split_part(NEW.email, '@', 1),
    substr(NEW.id::text, 1, 8)
  );

  -- Normalise: lowercase, strip anything that isn't [a-z0-9_-].
  base_username := lower(regexp_replace(base_username, '[^a-z0-9_-]+', '-', 'g'));
  base_username := trim(both '-' from base_username);
  IF base_username = '' OR base_username IS NULL THEN
    base_username := substr(NEW.id::text, 1, 8);
  END IF;

  candidate := base_username;

  -- Collision guard. Two bites at the apple, then give up and use uuid suffix.
  IF EXISTS (SELECT 1 FROM public.users WHERE username = candidate) THEN
    suffix := substr(replace(NEW.id::text, '-', ''), 1, 6);
    candidate := base_username || '-' || suffix;
  END IF;

  INSERT INTO public.users (id, username, display_name, avatar_url)
  VALUES (
    NEW.id,
    candidate,
    COALESCE(
      NEW.raw_user_meta_data ->> 'full_name',
      NEW.raw_user_meta_data ->> 'name',
      candidate
    ),
    NEW.raw_user_meta_data ->> 'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_user_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.users
  SET
    display_name = COALESCE(
      NEW.raw_user_meta_data ->> 'full_name',
      NEW.raw_user_meta_data ->> 'name',
      display_name
    ),
    avatar_url = COALESCE(NEW.raw_user_meta_data ->> 'avatar_url', avatar_url)
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

-- Drop & recreate to make this migration idempotent if re-run after a reset.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE OF raw_user_meta_data, email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_update();

-- Backfill: any auth.users rows that predate this migration (e.g. you
-- signed in during the auth-bringup work) need a matching public.users row.
-- This is a no-op on a fresh project.
INSERT INTO public.users (id, username, display_name, avatar_url)
SELECT
  au.id,
  COALESCE(
    NULLIF(lower(regexp_replace(split_part(au.email, '@', 1), '[^a-z0-9_-]+', '-', 'g')), ''),
    substr(au.id::text, 1, 8)
  ) AS username,
  COALESCE(
    au.raw_user_meta_data ->> 'full_name',
    au.raw_user_meta_data ->> 'name',
    split_part(au.email, '@', 1)
  ) AS display_name,
  au.raw_user_meta_data ->> 'avatar_url' AS avatar_url
FROM auth.users au
LEFT JOIN public.users pu ON pu.id = au.id
WHERE pu.id IS NULL
ON CONFLICT (id) DO NOTHING;
