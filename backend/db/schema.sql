-- Tenant config storage: replaces data/tenants/*.json.
--
-- This platform is single-purpose: survey/polling/research-organization
-- chatbots. It previously also supported a "consultancy" (visa/immigration)
-- vertical with its own faqs/programs/offices/serviced_countries tables and
-- system prompt — that's been removed. If you're upgrading an existing
-- database that still has those tables, see the migration note at the
-- bottom of this file; nothing below drops them automatically.
--
-- Design intent: the operational/technical config that has no real
-- internal structure (provider chain, branding theme, booking fields,
-- integrations) is JSONB — normalizing that would add tables for no query
-- benefit. Per-tenant survey content lives in survey_datasets, also JSONB
-- (see that table's comment for why — every survey has a genuinely
-- different shape, unlike the old consultancy vertical where every tenant
-- shared the same offices/programs/countries shape).
--
-- tenant_versions gives every save a rollback point. It's a full
-- snapshot (not a diff) — simpler to restore from, and tenant configs are
-- small enough that this is cheap.

CREATE TABLE IF NOT EXISTS tenants (
  id                  TEXT PRIMARY KEY,               -- e.g. 'datadarbar-insights' (was the filename)
  widget_title        TEXT NOT NULL DEFAULT 'Insight Bot',
  widget_subtitle     TEXT NOT NULL DEFAULT 'Survey Data Analyst',
  -- Shown in the widget's footer. Vertical-specific default ("Answers are
  -- strictly grounded to this organization's published research") is
  -- computed in server.js if this is NULL — only set here when a tenant
  -- wants custom wording.
  widget_footnote     TEXT,
  persona             TEXT,
  master_prompt       TEXT,                            -- overrides the built-in survey prompt, if set
  -- { provider: {...}, fallbackProviders: [...], internalProvider: {...} } — see resolveProviderEntry() in server.js
  provider_config     JSONB NOT NULL DEFAULT '{}',
  branding            JSONB NOT NULL DEFAULT '{}',      -- { theme: {...} }
  booking_fields      JSONB NOT NULL DEFAULT '[]',
  booking_availability JSONB NOT NULL DEFAULT '{}',
  allowed_origins     JSONB NOT NULL DEFAULT '[]',
  integrations        JSONB NOT NULL DEFAULT '{}',      -- notification connectors (SMTP/WhatsApp/webhook config)
  automations         JSONB NOT NULL DEFAULT '[]',
  suggested_questions JSONB NOT NULL DEFAULT '[]',
  -- tenant_meta.useKbOnly (see lib/systemPrompts.js) — skips the full
  -- dataset dump in the system prompt for large-KB tenants, relying solely
  -- on per-turn KB retrieval instead. Added after the initial schema; the
  -- ADD COLUMN IF NOT EXISTS below (not just here in the CREATE TABLE) is
  -- what actually applies it to a database that already ran an earlier
  -- version of this file — re-running schema.sql must stay safe on an
  -- existing DB, not just a fresh one.
  use_kb_only         BOOLEAN NOT NULL DEFAULT false,
  -- Per-tenant token the embedded widget must present on every public
  -- request (see server.js's isWidgetKeyValid). IMPORTANT: this can never
  -- be a true secret — it ships in a public <script> tag's HTML, visible
  -- to anyone who views page source. What it actually buys: per-tenant
  -- rate-limit/abuse granularity and the ability to REVOKE and rotate one
  -- tenant's key (e.g. after it's been scraped and abused) without
  -- touching any other tenant. NULL = not yet configured = open (same
  -- "unconfigured = feature off" convention as allowed_origins).
  widget_key          TEXT,
  -- Optional per-tenant dedicated infrastructure — see
  -- lib/db.js's getTenantPool() and kb-service's per-request Qdrant
  -- override. Shape: { databaseUrl, qdrantUrl, qdrantApiKey,
  -- qdrantCollection }. Any field left unset falls back to the shared
  -- platform default for that piece — a tenant can have a dedicated
  -- Postgres but still share the default Qdrant, or vice versa; this
  -- isn't all-or-nothing. Empty object / unset = fully shared (today's
  -- default for every existing tenant, zero behavior change).
  data_residency      JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS use_kb_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS widget_key TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS data_residency JSONB NOT NULL DEFAULT '{}';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS widget_footnote TEXT;

CREATE TABLE IF NOT EXISTS tenant_versions (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot    JSONB NOT NULL,        -- full assembled tenant JSON at save time (same shape as the old file)
  changed_by  TEXT,                  -- admin session identifier, if available
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_versions_tenant ON tenant_versions(tenant_id, changed_at DESC);

-- Deliberately NOT normalized into tables the way the old consultancy
-- vertical's faqs/programs/offices were. Every visa consultancy genuinely
-- had the same shape (offices, programs, serviced countries) — but every
-- SURVEY has its own unique top-level categories, because the content is
-- literally "whatever that specific survey/report set measured." One
-- tenant's data might be demographics/work_arrangement/productivity_tools;
-- another's might be store_locations/delivery_experience/complaint_
-- categories — there's no shared relational shape to normalize into, so
-- forcing one would just mean silently truncating whichever categories
-- didn't fit a schema designed around the first tenant seen. JSONB is the
-- correct model here, not a shortcut — same reasoning as tenants.branding/
-- integrations already being JSONB for the same "genuinely arbitrary
-- shape" reason.
--
-- survey_meta.researchDomains (an array, e.g. ["economy",
-- "politics-governance"]) is this vertical's equivalent of the old
-- consultancy vertical's serviced_countries hard boundary — see
-- buildSurveySystemPrompt in lib/systemPrompts.js. It lives inside this
-- JSONB column rather than its own table for the same reason as above:
-- it's tenant-declared free text, not a fixed enum to join against.
CREATE TABLE IF NOT EXISTS survey_datasets (
  tenant_id    TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  survey_meta  JSONB NOT NULL DEFAULT '{}',   -- title, conducted_by, date_range, total_respondents, researchDomains, etc.
  data         JSONB NOT NULL DEFAULT '{}',   -- everything else — demographics, satisfaction_metrics, whatever this dataset has
  "references" JSONB NOT NULL DEFAULT '[]',   -- [{ title, url }, ...] — quoted: reserved word in Postgres
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leads and conversations: replaces logs/leads.log and
-- logs/conversations.log. Kept here rather than in a separate migration
-- file since they share the same tenant FK and are part of the same
-- "get off flat files" move.
CREATE TABLE IF NOT EXISTS leads (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  fields      JSONB NOT NULL,        -- the tenant-configured booking fields, as submitted
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL,          -- 'user' | 'assistant'
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_tenant_session ON conversation_messages(tenant_id, session_id, created_at);

-- Durable backing for the admin analytics dashboard. Mirrors the flat
-- JSONL log files' entries 1:1 (log_type + the exact JSON that used to be
-- appended as a line) rather than a bespoke metrics schema — this is what
-- lets computeAnalytics() in lib/analytics.js reuse its existing
-- filter/aggregate logic almost unchanged, just fed from DB rows instead
-- of file lines. Without this table, every one of these metrics (response
-- times, token/cost tracking, thumbs up/down, intent breakdown) only ever
-- existed in a file on the backend's own ephemeral disk — wiped on every
-- redeploy, which is why "last 30 days" only ever showed data since the
-- most recent deploy. Conversation message *content* and lead *contact
-- info* already had their own durable tables (see conversation_messages
-- and leads above) — this table is specifically for the analytics-only
-- metering fields those don't capture (duration, tokens, cost, intent,
-- rating).
CREATE TABLE IF NOT EXISTS analytics_events (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT,                    -- nullable: some log types (e.g. a startup error) aren't tenant-scoped
  log_type    TEXT NOT NULL,           -- 'conversation' | 'lead' | 'feedback' | 'security' | 'error' | 'automation_execution'
  entry       JSONB NOT NULL,          -- the exact object that used to be JSON.stringify'd as one log line
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_lookup ON analytics_events(log_type, tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- MIGRATION NOTE for databases that ran an earlier version of this file
-- (i.e. before the consultancy vertical was removed):
--
-- The old `tenants.vertical` column and the faqs/programs/program_countries/
-- offices/office_destinations/serviced_countries tables are no longer read
-- or written by the application. This file does not drop them automatically
-- — do that manually once you've confirmed nothing still depends on them:
--
--   ALTER TABLE tenants DROP COLUMN IF EXISTS vertical;
--   DROP TABLE IF EXISTS office_destinations;
--   DROP TABLE IF EXISTS offices;
--   DROP TABLE IF EXISTS program_countries;
--   DROP TABLE IF EXISTS programs;
--   DROP TABLE IF EXISTS faqs;
--   DROP TABLE IF EXISTS serviced_countries;
-- ─────────────────────────────────────────────────────────────────────────
