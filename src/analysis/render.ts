import type { AuditReport } from "./audit";
import type { EntityMap } from "./entities";
import type { GeoQuery } from "./queries";

/** Readable Markdown for the audit. Concise: structured content carries the full detail. */
export function renderAudit(r: AuditReport): string {
  const L: string[] = [];
  const push = (s = "") => L.push(s);
  const list = (items: string[], max = 8) => {
    for (const i of items.slice(0, max)) push(`- ${i}`);
    if (items.length > max) push(`- ...and ${items.length - max} more (see structured content)`);
    if (items.length === 0) push("- none detected");
  };
  push(`# AI visibility audit: ${r.target}`);
  push();
  push(`Sampled ${r.crawl.pagesFetched} page(s) in ${(r.crawl.elapsedMs / 1000).toFixed(1)}s. ${r.methodology}`);
  if (r.crawl.pagesFailed.length) push(`Pages that could not be used: ${r.crawl.pagesFailed.map((p) => `${p.url} (${p.reason})`).join("; ")}`);
  push();
  push("## A. Executive summary");
  push(r.executiveSummary.diagnosis);
  push();
  const rt = r.executiveSummary.ratings;
  push(`Ratings: entity clarity ${rt.entityClarity} | AI retrievability ${rt.retrievability} | information gain ${rt.informationGain} | trust ${rt.trust} | architecture ${rt.architecture} | structured data ${rt.structuredData}`);
  list(r.executiveSummary.headline, 6);
  push();
  push("## B. Entity clarity");
  const pe = r.entityClarity.primaryEntity;
  push(`Primary entity: ${pe.name} (${pe.type}; ${pe.confidence} confidence from ${pe.source})${pe.alternates.length ? `; other names seen: ${pe.alternates.join(", ")}` : ""}`);
  const se = r.entityClarity.supportingEntities;
  if (se.people.length) push(`People: ${se.people.map((p) => `${p.name} (${p.role}, ${p.confidence})`).join("; ")}`);
  if (se.services.length) push(`Services: ${se.services.map((s) => s.name).join(", ")}`);
  if (se.products.length) push(`Products: ${se.products.map((s) => s.name).join(", ")}`);
  if (se.locations.length) push(`Locations: ${se.locations.map((l) => `${l.name} (${l.confidence})`).join(", ")}`);
  if (se.topics.length) push(`Topics: ${se.topics.join(", ")}`);
  push("Unclear or missing relationships:");
  list(r.entityClarity.unclearRelationships);
  push();
  push(`## C. AI retrievability: ${r.aiRetrievability.rating}`);
  list(r.aiRetrievability.siteWideIssues);
  for (const p of r.aiRetrievability.pages.slice(0, 8)) {
    push(`- ${p.url}: ${p.rating} (${p.words} words, ${p.specificityPer100} facts/100 words, ${p.fragmentationPct}% fragments, ${p.directAnswers}/${p.questionHeadings} questions answered directly)`);
    for (const i of p.issues.slice(0, 2)) push(`  - ${i}`);
  }
  push();
  push(`## D. Information gain: ${r.informationGain.rating}`);
  if (r.informationGain.found.length) list(r.informationGain.found.map((f) => `"${f.signal}" on ${f.page}: ${f.excerpt}`), 6);
  else push(`- ${r.informationGain.note}`);
  if (r.informationGain.notFound.length) push(`Not detected: ${r.informationGain.notFound.join("; ")}.`);
  push();
  push(`## E. Trust and corroboration: ${r.trustSignals.rating}`);
  const t = r.trustSignals;
  push(`Named people: ${t.namedPeople.length ? t.namedPeople.map((p) => `${p.name} (${p.role})`).join(", ") : "none"}`);
  push(`Identity: ${t.organisationIdentity.join("; ")}`);
  push(`Contact: ${t.contact.phones.length} phone, ${t.contact.emails.length} email, ${t.contact.addresses.length} address, contact page ${t.contact.hasContactPage ? "yes" : "no"}`);
  push(`Credentials: ${t.credentials.length ? t.credentials.join(", ") : "none detected"}`);
  push(`Third-party evidence: ${t.thirdPartyEvidence.length ? t.thirdPartyEvidence.join(", ") : "none detected"}`);
  push(`Outbound references: ${t.citations.length}${t.citations.length ? ` (${[...new Set(t.citations.map((c) => c.host))].slice(0, 6).join(", ")})` : ""}`);
  push("Gaps:");
  list(t.gaps);
  push();
  push(`## F. Internal linking and architecture: ${r.architecture.rating}`);
  list([...r.architecture.orphanLike.map((o) => `Orphan-like ${o.role} page ${o.url}: ${o.reason}`), ...r.architecture.hierarchyIssues, ...r.architecture.commercialToSupporting], 10);
  if (r.architecture.ambiguousAnchors.length) push(`Ambiguous anchors: ${r.architecture.ambiguousAnchors.map((a) => `"${a.text}" x${a.count}`).join(", ")}`);
  push();
  push(`## G. Structured data: ${r.structuredData.rating}`);
  push(`Types found: ${r.structuredData.typesFound.length ? r.structuredData.typesFound.map((x) => `${x.type} (${x.pages})`).join(", ") : "none"}`);
  push("Relevant omissions:");
  list(r.structuredData.omissions.map((o) => `${o.type} on ${o.where}: ${o.why}`), 6);
  if (r.structuredData.issues.length) {
    push("Issues:");
    list(r.structuredData.issues, 6);
  }
  push(r.structuredData.note);
  push();
  push("## H. Commercial query coverage");
  push(`Inferred category: ${r.commercialCoverage.inferredCategory}; offerings: ${r.commercialCoverage.inferredOfferings.slice(0, 8).join(", ") || "none"}; locations: ${r.commercialCoverage.inferredLocations.slice(0, 5).join(", ") || "none"}`);
  for (const i of r.commercialCoverage.likelyIntents.slice(0, 10)) push(`- ${i.intent}: ${i.coveredBy ? `covered by ${i.coveredBy}` : "no obvious page"}`);
  push("Gaps:");
  list(r.commercialCoverage.gaps);
  push();
  push("## I. Top recommended actions");
  for (const a of r.topActions) push(`${a.rank}. ${a.action} [impact ${a.impact}, visibility ${a.visibilityImpact}, effort ${a.effort}] ${a.why} Evidence: ${a.evidence}`);
  push();
  push("## J. 20 AI search prompts to monitor");
  for (const q of r.monitoringPrompts) push(`- ${q.query} (${q.intent}, ${q.buyerStage}, ${q.commercialPriority} priority; ideal page: ${q.idealPageType})`);
  return L.join("\n");
}

export function renderEntityMap(target: string, m: EntityMap): string {
  const L: string[] = [];
  const push = (s = "") => L.push(s);
  push(`# Entity map: ${target}`);
  push();
  push(`## Primary entity`);
  push(`${m.primaryEntity.name} (${m.primaryEntity.type}); confidence ${m.primaryEntity.confidence} from ${m.primaryEntity.source}${m.primaryEntity.alternates.length ? `; alternates: ${m.primaryEntity.alternates.join(", ")}` : ""}`);
  push();
  push("## Related entities");
  const re = m.relatedEntities;
  push(`People: ${re.people.length ? re.people.map((p) => `${p.name} (${p.role}; ${p.confidence})`).join("; ") : "none detected"}`);
  push(`Organisation/brand: ${re.organisation.map((o) => `${o.name} (${o.confidence})`).join("; ")}`);
  push(`Products: ${re.products.length ? re.products.map((p) => p.name).join(", ") : "none detected"}`);
  push(`Services: ${re.services.length ? re.services.map((p) => p.name).join(", ") : "none detected"}`);
  push(`Locations: ${re.locations.length ? re.locations.map((l) => `${l.name} (${l.confidence})`).join(", ") : "none detected"}`);
  push(`Topics/categories: ${re.topics.length ? re.topics.join(", ") : "none detected"}`);
  push();
  push("## Entity relationships");
  for (const r of m.relationships) push(`- ${r.subject} -> ${r.predicate} -> ${r.object} (${r.confidence}; ${r.evidence})`);
  if (!m.relationships.length) push("- none could be established");
  push();
  push("## Entity ambiguities");
  for (const a of m.ambiguities) push(`- ${a}`);
  if (!m.ambiguities.length) push("- none detected");
  push();
  push("## Missing entity support");
  for (const a of m.missingSupport) push(`- ${a}`);
  if (!m.missingSupport.length) push("- nothing obvious");
  push();
  push(`## Schema types found`);
  push(m.schemaTypesFound.length ? m.schemaTypesFound.map((t) => `${t.type} (${t.pages} page${t.pages === 1 ? "" : "s"})`).join(", ") : "none");
  push();
  push("## Suggested schema types");
  for (const s of m.suggestedSchemaTypes) push(`- ${s.type} on ${s.where}: ${s.why}`);
  if (!m.suggestedSchemaTypes.length) push("- current coverage is appropriate for the visible business");
  return L.join("\n");
}

export function renderQueries(target: string, meta: { brand: string; category: string; location?: string; services: string[] }, queries: GeoQuery[]): string {
  const L: string[] = [];
  L.push(`# GEO query universe: ${target}`);
  L.push("");
  L.push(`Brand: ${meta.brand}; category: ${meta.category}; location: ${meta.location ?? "not location-specific"}; services used: ${meta.services.slice(0, 6).join(", ") || "none detected"}`);
  L.push(`${queries.length} prompts. Monitor these in ChatGPT, Claude, Perplexity, Gemini and Google AI Mode; record whether the brand is mentioned, cited, or recommended.`);
  const groups = new Map<string, GeoQuery[]>();
  for (const q of queries) groups.set(q.intent, [...(groups.get(q.intent) ?? []), q]);
  for (const [intent, qs] of groups) {
    L.push("");
    L.push(`## ${intent} (${qs.length})`);
    for (const q of qs) L.push(`- ${q.query} | stage: ${q.buyerStage} | ideal page: ${q.idealPageType} | priority: ${q.commercialPriority}`);
  }
  return L.join("\n");
}
