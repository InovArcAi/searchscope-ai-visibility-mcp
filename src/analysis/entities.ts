import type { SiteModel, Confidence } from "./site";
import { EDU_TYPES, ORG_TYPES, stripBrandSuffix } from "./site";

export interface EntityRelationship {
  subject: string;
  predicate: string;
  object: string;
  confidence: Confidence;
  evidence: string;
}

export interface EntityMap {
  primaryEntity: { name: string; type: string; confidence: Confidence; source: string; alternates: string[] };
  relatedEntities: {
    people: { name: string; role: string; confidence: Confidence; source: string }[];
    organisation: { name: string; confidence: Confidence; source: string }[];
    products: { name: string; confidence: Confidence; source: string }[];
    services: { name: string; confidence: Confidence; source: string }[];
    locations: { name: string; confidence: Confidence; source: string }[];
    topics: string[];
  };
  relationships: EntityRelationship[];
  ambiguities: string[];
  missingSupport: string[];
  schemaTypesFound: { type: string; pages: number }[];
  suggestedSchemaTypes: { type: string; where: string; why: string }[];
}

const LOCAL_BUSINESS_HINT = /(plumb|electric|roof|dentist|dental|clinic|physio|chiro|lawyer|solicitor|accountant|restaurant|cafe|salon|gym|mechanic|builder|landscap|cleaning|removal|storage|florist|vet|pharmacy|hotel|real estate|agent|repair|installation|pest|painting|tiling|concrete|fencing|glazier|locksmith|tutor|childcare|day care|therapist|counsell|massage|barber|bakery|butcher|catering|mortgage|broker|insurance|conveyanc|migration|tax)/i;

export function buildEntityMap(site: SiteModel): EntityMap {
  // Educational types are excluded: on a consultancy site they are the founder's
  // university, not the business, and picking one as the primary entity type is
  // worse than falling back to an inferred LocalBusiness.
  const orgTypes = [...site.schemaTypes.keys()].filter((t) => ORG_TYPES.test(t) && !EDU_TYPES.test(t));
  const isLocal = site.locations.some((l) => l.confidence !== "low") || site.addresses.length > 0 || site.phones.length > 0;
  const primaryType = orgTypes.find((t) => t !== "Organization" && t !== "WebSite") ?? (isLocal && LOCAL_BUSINESS_HINT.test(site.offerings.map((o) => o.value).join(" ") + " " + (site.home?.parsed.title ?? "")) ? "LocalBusiness (inferred)" : "Organization (inferred)");

  const services = site.offeringKind === "products" ? [] : site.offerings.filter((o) => !/^(Product)/.test(o.source) && !(site.offeringKind === "mixed" && /product/i.test(o.source)));
  const products = site.offeringKind === "services" ? [] : site.offerings.filter((o) => site.offeringKind === "products" || /product/i.test(o.source));

  const relationships: EntityRelationship[] = [];
  const brand = site.brand.value;
  for (const o of services.slice(0, 10)) relationships.push({ subject: brand, predicate: "offers", object: o.value, confidence: o.confidence, evidence: o.source });
  for (const p of products.slice(0, 10)) relationships.push({ subject: brand, predicate: "sells", object: p.value, confidence: p.confidence, evidence: p.source });
  const strongLocs = site.locations.filter((l) => l.confidence !== "low");
  for (const l of strongLocs.slice(0, 6)) {
    relationships.push({ subject: brand, predicate: /areaServed|servicing|serving|across|throughout/i.test(l.source) ? "serves" : "located in", object: l.value, confidence: l.confidence, evidence: l.source });
  }
  for (const p of site.people.slice(0, 8)) {
    relationships.push({ subject: p.name, predicate: p.role ? `${p.role.toLowerCase()} of` : "associated with", object: brand, confidence: p.role ? p.confidence : "low", evidence: p.source });
  }
  for (const s of site.sameAs.slice(0, 6)) relationships.push({ subject: brand, predicate: "sameAs", object: s, confidence: "high", evidence: "JSON-LD sameAs" });
  if (site.legalName) relationships.push({ subject: brand, predicate: "legal entity", object: site.legalName.value, confidence: site.legalName.confidence, evidence: site.legalName.source });

  const ambiguities: string[] = [];
  // "Polytechnitis" and "Polytechnitis Handy Man Services" are the same
  // business written short and long, not two competing names. Only genuinely
  // different names are worth raising.
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const distinctBrands = site.brandCandidates
    .filter((b) => b.confidence !== "low")
    .filter((b, i, all) => !all.some((other, j) => j < i && (norm(other.value).includes(norm(b.value)) || norm(b.value).includes(norm(other.value)))));
  if (distinctBrands.length > 1) {
    ambiguities.push(`Brand name is stated inconsistently: ${distinctBrands.map((b) => `"${b.value}" (${b.source})`).join(" vs ")}. Pick one canonical name and use it in schema, og:site_name, title suffix and footer.`);
  }
  if (site.brand.confidence === "low") ambiguities.push("No explicit organisation name found in schema, og:site_name or repeated title suffix; the brand entity is inferred from the domain name only.");
  if (strongLocs.length === 0 && (site.phones.length > 0 || LOCAL_BUSINESS_HINT.test(site.offerings.map((o) => o.value).join(" ")))) {
    ambiguities.push("The business looks location-dependent (phone number and service type) but no service area or address is stated clearly. Assistants cannot tell where you operate.");
  }
  if (strongLocs.length > 6) ambiguities.push(`${strongLocs.length} locations are mentioned with no clear primary location. State the home base and the service area separately.`);
  const roleless = site.people.filter((p) => !p.role);
  if (roleless.length > 0) ambiguities.push(`People named without a stated role or relationship to the business: ${roleless.map((p) => p.name).join(", ")}.`);
  if (site.people.length === 0) ambiguities.push("No named people found (founder, owner, practitioners, authors). The organisation has no human corroboration on-site.");
  if (services.length + products.length === 0) ambiguities.push("No offerings could be identified from schema, navigation or service page headings. The core commercial entity is unclear.");
  if (site.offerings.length > 0 && !site.schemaTypes.has("Service") && !site.schemaTypes.has("Product") && !site.schemaTypes.has("Offer")) {
    ambiguities.push("Offerings are only expressed in navigation and headings, never as Service/Product entities linked to the organisation.");
  }
  const homeH1 = site.home?.parsed.headings.h1 ?? [];
  if (homeH1.length === 0) ambiguities.push("Homepage has no H1, so the page's primary topic is not declared.");
  if (homeH1.length > 1) ambiguities.push(`Homepage has ${homeH1.length} H1 headings, which splits the page's declared topic.`);
  if (site.brand.confidence !== "low" && site.home && !new RegExp(site.brand.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(`${site.home.parsed.title} ${site.home.parsed.headings.h1.join(" ")} ${site.home.parsed.paragraphs.slice(0, 3).join(" ")}`)) {
    ambiguities.push(`The brand name "${site.brand.value}" does not appear in the homepage title, H1 or opening copy.`);
  }

  const missing: string[] = [];
  if (!orgTypes.length) missing.push(`Add ${primaryType.replace(" (inferred)", "")} JSON-LD on the homepage with name, url, logo, telephone, address (if local), areaServed, founder and sameAs pointing at every real profile.`);
  else if (site.sameAs.length === 0) missing.push("The organisation schema has no sameAs links. Add the Google Business Profile, LinkedIn, Facebook and any directory or association profiles so the entity can be reconciled across sources.");
  if (!site.pages.some((p) => p.role === "about")) missing.push("Add or surface an About page that states who runs the business, since when, where, and for whom, in plain prose (not just a mission statement).");
  if (site.people.length > 0 && !site.schemaTypes.has("Person")) missing.push(`Add Person schema for ${site.people.slice(0, 2).map((p) => p.name).join(" and ")} with jobTitle, worksFor and sameAs, and a bio paragraph on the About page.`);
  if (strongLocs.length > 0 && !site.addresses.length && !site.schemaTypes.has("PostalAddress")) missing.push("Publish a full postal address (or at minimum suburb, state and postcode) in the footer and in schema; location claims in copy alone are weak.");
  if (site.offerings.length > 0 && !site.schemaTypes.has("Service") && !site.schemaTypes.has("Product")) missing.push(`Describe each offering as a Service or Product entity (name, description, provider, areaServed) on its own page, one entity per page.`);
  if (site.legalName === undefined && site.businessIds.length === 0) missing.push("State the legal entity name and registration number (for Australia: ABN) in the footer or on the About/Contact page.");
  if (site.pages.filter((p) => p.role === "service" || p.role === "product").length === 0) missing.push("Create one page per core offering. Assistants map entities to pages; a single services list on the homepage does not establish separate service entities.");
  if (site.credentials.length === 0) missing.push("No credentials, licences, memberships or awards detected. If they exist, state them explicitly with the issuing body.");

  const schemaTypesFound = [...site.schemaTypes.entries()].map(([type, pages]) => ({ type, pages: pages.length })).sort((a, b) => b.pages - a.pages);
  const suggested: EntityMap["suggestedSchemaTypes"] = [];
  const has = (t: string) => site.schemaTypes.has(t);
  if (!orgTypes.length) suggested.push({ type: primaryType.replace(" (inferred)", ""), where: "homepage (and every page via @id reference)", why: "Declares the primary entity, its name, contact points and sameAs profiles." });
  if (!has("WebSite")) suggested.push({ type: "WebSite", where: "homepage", why: "Names the site and links it to the publisher organisation." });
  if (site.people.length > 0 && !has("Person")) suggested.push({ type: "Person", where: "About or team page", why: "Establishes the named people behind the business and their roles." });
  if (services.length > 0 && !has("Service")) suggested.push({ type: "Service", where: "each service page", why: "One Service entity per page with provider and areaServed makes the offering machine-readable." });
  if (products.length > 0 && !has("Product")) suggested.push({ type: "Product", where: "each product page", why: "Product with offers (price, availability) is the only way product facts are reliably extracted." });
  if (site.pages.some((p) => p.role === "informational") && !has("Article") && !has("BlogPosting")) suggested.push({ type: "Article or BlogPosting", where: "blog posts and guides", why: "Carries author, datePublished and dateModified, which are visible trust signals for content." });
  if (site.pages.some((p) => p.finalUrl.split("/").filter(Boolean).length >= 3) && !has("BreadcrumbList")) suggested.push({ type: "BreadcrumbList", where: "pages two or more levels deep", why: "Expresses the hierarchy between category, service and supporting pages." });
  if (strongLocs.length > 0 && !has("PostalAddress")) suggested.push({ type: "PostalAddress (inside the business entity)", where: "homepage and contact page", why: "Anchors the entity to a place; areaServed alone does not." });
  // Deliberately not suggested: FAQPage and HowTo (no longer produce anything in Google Search since 2026) and
  // self-serving Review/AggregateRating on your own organisation (ineligible since 2019).

  return {
    primaryEntity: { name: brand, type: primaryType, confidence: site.brand.confidence, source: site.brand.source, alternates: site.brandCandidates.slice(1).map((b) => b.value) },
    relatedEntities: {
      people: site.people.map((p) => ({ name: p.name, role: p.role || "unknown", confidence: p.confidence, source: p.source })),
      organisation: [
        { name: brand, confidence: site.brand.confidence, source: site.brand.source },
        ...(site.legalName ? [{ name: site.legalName.value, confidence: site.legalName.confidence, source: site.legalName.source }] : []),
      ],
      products: products.map((p) => ({ name: p.value, confidence: p.confidence, source: p.source })),
      services: services.map((s) => ({ name: s.value, confidence: s.confidence, source: s.source })),
      locations: site.locations.map((l) => ({ name: l.value, confidence: l.confidence, source: l.source })),
      topics: site.topics.map((t) => stripBrandSuffix(t, brand)),
    },
    relationships,
    ambiguities,
    missingSupport: missing,
    schemaTypesFound,
    suggestedSchemaTypes: suggested,
  };
}
