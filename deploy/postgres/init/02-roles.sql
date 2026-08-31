-- AgQL separates database privileges into three distinct roles (RFC v0 §9):
--   * the provisioner role  — owns DDL, never reachable from a request path
--   * agql_query            — read-only, used by the query pool via SET ROLE
--   * agql_writer           — read/write, used by the ingest pool via SET ROLE
--
-- The provisioner is the role the service connects as (from DATABASE_URL). The
-- other two are NOLOGIN: nothing ever authenticates as them directly, the pools
-- assume them with SET ROLE, which is what keeps a compromised query path
-- unable to write and a compromised write path unable to alter schemas.
--
-- The adapter's provisioner GRANTs object privileges to these roles per
-- namespace, so it requires them to already exist. Creating them is an operator
-- concern, which is why it lives here rather than in application code.
--
-- Idempotent: safe to re-run, and only executes on first database init anyway.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agql_query') THEN
    CREATE ROLE agql_query NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agql_writer') THEN
    CREATE ROLE agql_writer NOLOGIN;
  END IF;
END
$$;

-- The connecting provisioner role must be a member of both tiers so its pools
-- can SET ROLE into them. current_user keeps this correct if POSTGRES_USER is
-- renamed; current_database() likewise.
DO $$
BEGIN
  EXECUTE format('GRANT agql_query, agql_writer TO %I', current_user);
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO agql_query, agql_writer',
    current_database()
  );
END
$$;
