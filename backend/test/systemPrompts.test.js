const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSystemPrompt } = require("../lib/systemPrompts");

test("buildSystemPrompt: builds the survey/research-analyst template by default", () => {
  const prompt = buildSystemPrompt({ survey_meta: { title: "X" } }, null, null, false);
  assert.match(prompt, /survey and public-opinion research assistant/i);
});

test("buildSystemPrompt: a masterPrompt overrides the built-in template entirely, but keeps the technical contract", () => {
  const prompt = buildSystemPrompt({ foo: "bar" }, null, "You are Bob, a friendly pirate.", false);
  assert.match(prompt, /You are Bob, a friendly pirate\./);
  // The required technical contract (anti-injection instruction + followups
  // block) must survive regardless of what the tenant's custom prompt says —
  // this is the platform's non-negotiable wiring underneath admin content.
  assert.match(prompt, /REQUIRED TECHNICAL CONTRACT/);
  assert.match(prompt, /"followups"/);
});

test("buildSystemPrompt: researchDomains boundary is included when survey_meta.researchDomains is set", () => {
  const prompt = buildSystemPrompt({ survey_meta: { researchDomains: ["economy", "public-health"] } }, null, null, false);
  assert.match(prompt, /RESEARCH DOMAINS THIS ORGANIZATION PUBLISHES ON/);
  assert.match(prompt, /economy, public-health/);
});

test("buildSystemPrompt: researchDomains boundary is omitted entirely when not set", () => {
  const prompt = buildSystemPrompt({ survey_meta: {} }, null, null, false);
  assert.doesNotMatch(prompt, /RESEARCH DOMAINS THIS ORGANIZATION PUBLISHES ON/);
});

test("buildSystemPrompt: citation-discipline block only appears when useKbOnly is true", () => {
  const withKb = buildSystemPrompt({ survey_meta: {} }, null, null, true);
  const withoutKb = buildSystemPrompt({ survey_meta: {} }, null, null, false);
  assert.match(withKb, /CITATION DISCIPLINE/);
  assert.doesNotMatch(withoutKb, /CITATION DISCIPLINE/);
});

test("buildSystemPrompt: citation-discipline block requires per-report dates and forbids blending sources", () => {
  const prompt = buildSystemPrompt({ survey_meta: {} }, null, null, true);
  assert.match(prompt, /NEVER blend, average, or combine numbers from two different reports/);
  assert.match(prompt, /chronological Markdown table/);
});

test("buildSystemPrompt: tenant isolation — two different payloads never leak into each other's prompt", () => {
  const tenantA = { survey_meta: { title: "Tenant A Survey" }, secretMarkerA: "AAA-only-visible-here" };
  const tenantB = { survey_meta: { title: "Tenant B Survey" }, secretMarkerB: "BBB-only-visible-here" };

  const promptA = buildSystemPrompt(tenantA, null, null, false);
  const promptB = buildSystemPrompt(tenantB, null, null, false);

  assert.match(promptA, /AAA-only-visible-here/);
  assert.doesNotMatch(promptA, /BBB-only-visible-here/);
  assert.match(promptB, /BBB-only-visible-here/);
  assert.doesNotMatch(promptB, /AAA-only-visible-here/);
});

test("buildSystemPrompt: useKbOnly=true excludes the full dataset dump from the prompt", () => {
  const bigPayload = { secretField: "this-should-not-appear-in-the-prompt-text", items: new Array(500).fill("x") };
  const prompt = buildSystemPrompt(bigPayload, null, null, true);
  assert.doesNotMatch(prompt, /this-should-not-appear-in-the-prompt-text/);
  assert.match(prompt, /NOT embedded above/);
});

test("buildSystemPrompt: useKbOnly=false (default) DOES embed the full dataset", () => {
  const payload = { markerField: "marker-should-appear-here" };
  const prompt = buildSystemPrompt(payload, null, null, false);
  assert.match(prompt, /marker-should-appear-here/);
});

test("buildSystemPrompt: persona text is included when provided", () => {
  const prompt = buildSystemPrompt({}, "Speak like a pirate, always say arr.", null, false);
  assert.match(prompt, /Speak like a pirate, always say arr\./);
});
