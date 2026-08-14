// DB-backed tenant config store. Reconstructs the exact same "raw tenant
// JSON" shape server.js's buildTenantsMap() used to read straight off
// disk — { tenant_meta, suggested_questions, survey_meta, references,
// ...surveyData } — so buildTenantsMap only needs to swap *where* raw
// tenant objects come from, not how it turns them into the in-memory
// tenant map. See db/schema.sql for the table shape this reads from and
// writes to (survey_datasets).
const db = require("./db");
const crypto = require("crypto");

function isConfigured() {
  return db.isConfigured();
}

async function loadAllTenants() {
  const { rows: tenantRows } = await db.query("SELECT * FROM tenants ORDER BY id");
  const ids = tenantRows.map((t) => t.id);
  if (ids.length === 0) return [];

  const { rows: surveyRows } = await db.query('SELECT * FROM survey_datasets WHERE tenant_id = ANY($1)', [ids]);
  const surveyByTenant = {};
  for (const r of surveyRows) surveyByTenant[r.tenant_id] = r;

  return tenantRows.map((t) => ({
    id: t.id,
    raw: {
      tenant_meta: {
        widget_title: t.widget_title,
        widget_subtitle: t.widget_subtitle,
        persona: t.persona || undefined,
        masterPrompt: t.master_prompt || undefined,
        useKbOnly: t.use_kb_only || undefined,
        widgetKey: t.widget_key || undefined,
        dataResidency: t.data_residency && Object.keys(t.data_residency).length ? t.data_residency : undefined,
        provider: t.provider_config?.provider || undefined,
        fallbackProviders: t.provider_config?.fallbackProviders || undefined,
        internalProvider: t.provider_config?.internalProvider || undefined,
        allowedOrigins: t.allowed_origins || [],
        integrations: t.integrations || {},
        automations: t.automations || undefined,
        booking: { fields: t.booking_fields || [], availability: t.booking_availability || {} },
        branding: { theme: t.branding?.theme || undefined },
        widgetFootnote: t.widget_footnote || undefined,
      },
      suggested_questions: t.suggested_questions || [],
      survey_meta: surveyByTenant[t.id]?.survey_meta || {},
      references: surveyByTenant[t.id]?.references || [],
      ...(surveyByTenant[t.id]?.data || {}),
    },
  }));
}

// Writes one tenant's full config in a single transaction: upserts the
// tenants row, replaces (delete+reinsert) its survey_datasets row, and
// appends a tenant_versions snapshot. Replace-rather-than-diff keeps this
// simple and matches how the admin panel already sends "the whole tenant"
// on every save — there's no partial-update UI to support yet.
async function saveTenant(tenantId, raw, changedBy = null) {
  const tenant_meta = raw.tenant_meta || {};

  return db.withTransaction(async (client) => {
    // Widget key: NEVER silently rotate an existing one just because an
    // unrelated field changed in this save — that would invalidate a
    // tenant's already-deployed embed script without anyone asking for
    // that. Precedence: explicit value in this save > whatever's already
    // in the DB > freshly generated (first-ever save for this tenant).
    const { rows: existingRows } = await client.query("SELECT widget_key FROM tenants WHERE id = $1", [tenantId]);
    const existingKey = existingRows[0]?.widget_key || null;
    const widgetKey = tenant_meta.widgetKey || existingKey || crypto.randomBytes(24).toString("hex");

    await client.query(
      `INSERT INTO tenants (id, widget_title, widget_subtitle, widget_footnote, persona, master_prompt, provider_config,
                             branding, booking_fields, booking_availability, allowed_origins, integrations,
                             automations, suggested_questions, use_kb_only, widget_key, data_residency, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
       ON CONFLICT (id) DO UPDATE SET
         widget_title = EXCLUDED.widget_title, widget_subtitle = EXCLUDED.widget_subtitle,
         widget_footnote = EXCLUDED.widget_footnote,
         persona = EXCLUDED.persona, master_prompt = EXCLUDED.master_prompt, provider_config = EXCLUDED.provider_config,
         branding = EXCLUDED.branding, booking_fields = EXCLUDED.booking_fields, booking_availability = EXCLUDED.booking_availability,
         allowed_origins = EXCLUDED.allowed_origins, integrations = EXCLUDED.integrations, automations = EXCLUDED.automations,
         suggested_questions = EXCLUDED.suggested_questions, use_kb_only = EXCLUDED.use_kb_only,
         widget_key = EXCLUDED.widget_key, data_residency = EXCLUDED.data_residency, updated_at = now()`,
      [
        tenantId,
        tenant_meta.widget_title || "Insight Bot",
        tenant_meta.widget_subtitle || "Survey Data Analyst",
        tenant_meta.widgetFootnote || null,
        tenant_meta.persona || null,
        tenant_meta.masterPrompt || null,
        JSON.stringify({
          provider: tenant_meta.provider || null,
          fallbackProviders: tenant_meta.fallbackProviders || null,
          internalProvider: tenant_meta.internalProvider || null,
        }),
        JSON.stringify({ theme: tenant_meta.branding?.theme || null }),
        JSON.stringify(tenant_meta.booking?.fields || []),
        JSON.stringify(tenant_meta.booking?.availability || {}),
        JSON.stringify(tenant_meta.allowedOrigins || []),
        JSON.stringify(tenant_meta.integrations || {}),
        JSON.stringify(tenant_meta.automations || []),
        JSON.stringify(raw.suggested_questions || []),
        !!tenant_meta.useKbOnly,
        widgetKey,
        JSON.stringify(tenant_meta.dataResidency || {}),
      ]
    );

    // Everything except tenant_meta/suggested_questions/survey_meta/
    // references is genuinely arbitrary per-survey content (demographics,
    // satisfaction_metrics, whatever that dataset has) — see db/schema.sql's
    // survey_datasets comment for why this is JSONB, not normalized tables.
    const { tenant_meta: _tm, suggested_questions: _sq, survey_meta, references, ...surveyData } = raw;
    await client.query(
      `INSERT INTO survey_datasets (tenant_id, survey_meta, data, "references", updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         survey_meta = EXCLUDED.survey_meta, data = EXCLUDED.data, "references" = EXCLUDED."references", updated_at = now()`,
      [tenantId, JSON.stringify(survey_meta || {}), JSON.stringify(surveyData), JSON.stringify(references || [])]
    );

    await client.query(
      "INSERT INTO tenant_versions (tenant_id, snapshot, changed_by) VALUES ($1,$2,$3)",
      [tenantId, JSON.stringify(raw), changedBy]
    );
  });
}

async function getRawTenant(tenantId) {
  const all = await loadAllTenants();
  return all.find((t) => t.id === tenantId) || null;
}

// Explicit rotation (e.g. after a widget key was scraped/abused) — a
// direct UPDATE, not a full saveTenant() round-trip, so this can't
// accidentally clobber any other field a concurrent admin edit might be
// mid-way through. Returns the new key so the caller can show it once,
// immediately, in the admin panel's embed snippet.
async function regenerateWidgetKey(tenantId) {
  const newKey = crypto.randomBytes(24).toString("hex");
  const { rows } = await db.query(
    "UPDATE tenants SET widget_key = $1, updated_at = now() WHERE id = $2 RETURNING widget_key",
    [newKey, tenantId]
  );
  return rows[0]?.widget_key || null;
}

async function tenantExists(tenantId) {
  const { rows } = await db.query("SELECT 1 FROM tenants WHERE id = $1", [tenantId]);
  return rows.length > 0;
}

async function deleteTenant(tenantId) {
  // ON DELETE CASCADE on every child table handles survey_datasets/leads/
  // conversation_messages/tenant_versions.
  await db.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function getTenantHistory(tenantId, limit = 20) {
  const { rows } = await db.query(
    "SELECT id, changed_by, changed_at FROM tenant_versions WHERE tenant_id = $1 ORDER BY changed_at DESC LIMIT $2",
    [tenantId, limit]
  );
  return rows;
}

async function getTenantVersionSnapshot(versionId) {
  const { rows } = await db.query("SELECT snapshot FROM tenant_versions WHERE id = $1", [versionId]);
  return rows[0]?.snapshot || null;
}

module.exports = { isConfigured, loadAllTenants, saveTenant, getRawTenant, tenantExists, deleteTenant, getTenantHistory, getTenantVersionSnapshot, regenerateWidgetKey };
