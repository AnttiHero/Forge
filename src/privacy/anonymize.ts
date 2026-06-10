/**
 * Legal entity anonymization — adapted from Lavern's claw anonymizer.
 *
 * Replaces confidential entities (fund names, investor names, parties,
 * monetary amounts, dates, emails, phones) with stable placeholders such as
 * `[FUND_1]` and `[AMOUNT_3]`. The mapping table is returned so results can
 * be de-anonymized after the frontier call.
 *
 * All logic is local — regex only, no external dependencies, no LLM calls.
 * A persistent registry can be passed in so the same entity maps to the
 * same placeholder across every call of a pipeline run.
 */

// ── Types ────────────────────────────────────────────────────────────────

export type EntityType = 'fund' | 'investor' | 'party' | 'amount' | 'date' | 'email' | 'phone';

export interface EntityMapping {
  /** Stable placeholder, e.g. "[FUND_1]", "[AMOUNT_3]" */
  placeholder: string;
  /** Original matched text, e.g. "Vulcan Industrial Partners III" */
  original: string;
  type: EntityType;
}

export interface TypedTerm {
  term: string;
  type: EntityType;
}

/** Persistent placeholder registry — share across calls for stable mappings. */
export interface AnonymizationRegistry {
  knownEntities: Map<string, string>;
  counters: Record<EntityType, number>;
  mappings: EntityMapping[];
}

export interface AnonymizationResult {
  anonymizedText: string;
  /** Full mapping table of the registry (cumulative when registry reused). */
  mappings: EntityMapping[];
  /** Per-category counts of unique entities in the registry. */
  stats: Record<EntityType, number>;
}

// ── Constants ────────────────────────────────────────────────────────────

/** Role words and common legal terms that must never be treated as names —
 *  keeping roles like "General Partner" intact preserves prompt coherence. */
const SKIP_TERMS = new Set([
  'agreement',
  'fund',
  'partnership',
  'general partner',
  'limited partner',
  'limited partners',
  'investor',
  'investors',
  'manager',
  'advisory board',
  'side letter',
  'term',
  'party',
  'parties',
  'effective date',
]);

const TYPE_LABELS: Record<EntityType, string> = {
  fund: 'FUND',
  investor: 'INVESTOR',
  party: 'PARTY',
  amount: 'AMOUNT',
  date: 'DATE',
  email: 'EMAIL',
  phone: 'PHONE',
};

const ENTITY_TYPES: EntityType[] = ['fund', 'investor', 'party', 'amount', 'date', 'email', 'phone'];

// ── Regex patterns (lifted from Lavern claw/anonymize.ts) ───────────────

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+\d{1,3}[\s\-.]?)?\(?\d{3,4}\)?[\s\-.]\d{3,4}[\s\-.]\d{3,4}/g;
const MONEY_SYMBOL_RE = /[$€£]\s?\d{1,3}(?:[,.\s]\d{3})*(?:\.\d{1,2})?(?:\s?(?:million|billion|trillion|bn|mm|m\b))?/gi;
const MONEY_CODE_RE = /\b(?:USD|EUR|GBP|CHF|JPY|CAD|AUD)\s?\d{1,3}(?:[,.\s]\d{3})*(?:\.\d{1,2})?\b/g;
const MONEY_WRITTEN_RE =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand|million|billion|trillion)(?:\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand|million|billion|trillion))*\s+(?:dollars?|euros?|pounds?|USD|EUR|GBP)\b/gi;
const DATE_LONG_RE =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi;
const DATE_ORDINAL_RE =
  /\b\d{1,2}(?:st|nd|rd|th)\s+day\s+of\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+\d{4}\b/gi;
const DATE_SLASH_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const DATE_ISO_RE = /\b\d{4}-\d{2}-\d{2}\b/g;

// ── Internal helpers ─────────────────────────────────────────────────────

interface FoundEntity {
  start: number;
  end: number;
  text: string;
  type: EntityType;
}

function collectMatches(text: string, re: RegExp, type: EntityType): FoundEntity[] {
  const results: FoundEntity[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push({ start: m.index, end: m.index + m[0].length, text: m[0], type });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return results;
}

function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Lookarounds instead of \b: terms ending in punctuation ("L.P.") have no
  // word boundary after the final "." and would silently never match.
  return new RegExp(`(?<!\\w)${escaped}(?!\\w)`, 'gi');
}

function overlaps(span: { start: number; end: number }, claimed: { start: number; end: number }[]): boolean {
  return claimed.some((c) => span.start < c.end && span.end > c.start);
}

// ── Public API ───────────────────────────────────────────────────────────

export function createRegistry(): AnonymizationRegistry {
  const counters = {} as Record<EntityType, number>;
  for (const t of ENTITY_TYPES) counters[t] = 0;
  return { knownEntities: new Map(), counters, mappings: [] };
}

export function registryStats(registry: AnonymizationRegistry): Record<EntityType, number> {
  const stats = {} as Record<EntityType, number>;
  for (const t of ENTITY_TYPES) stats[t] = 0;
  for (const m of registry.mappings) stats[m.type] += 1;
  return stats;
}

/**
 * Anonymize text by replacing entities with stable placeholders.
 *
 * @param text      Text to anonymize.
 * @param terms     Known confidential terms (fund/investor/party names).
 * @param registry  Optional persistent registry for cross-call stability.
 */
export function anonymize(
  text: string,
  terms: TypedTerm[] = [],
  registry: AnonymizationRegistry = createRegistry(),
): AnonymizationResult {
  function register(original: string, type: EntityType): string {
    const key = `${type}::${original.toLowerCase().trim()}`;
    const existing = registry.knownEntities.get(key);
    if (existing) return existing;
    registry.counters[type] += 1;
    const placeholder = `[${TYPE_LABELS[type]}_${registry.counters[type]}]`;
    registry.knownEntities.set(key, placeholder);
    registry.mappings.push({ placeholder, original, type });
    return placeholder;
  }

  const allEntities: FoundEntity[] = [];

  // Named terms first (longest first so "Vulcan Industrial Partners III"
  // beats "Vulcan Industrial Partners")
  const sortedTerms = [...terms].sort((a, b) => b.term.length - a.term.length);
  for (const { term, type } of sortedTerms) {
    if (!term || term.length < 3) continue;
    if (SKIP_TERMS.has(term.toLowerCase())) continue;
    allEntities.push(...collectMatches(text, termRegex(term), type));
  }

  allEntities.push(...collectMatches(text, MONEY_WRITTEN_RE, 'amount'));
  allEntities.push(...collectMatches(text, MONEY_SYMBOL_RE, 'amount'));
  allEntities.push(...collectMatches(text, MONEY_CODE_RE, 'amount'));
  allEntities.push(...collectMatches(text, DATE_ORDINAL_RE, 'date'));
  allEntities.push(...collectMatches(text, DATE_LONG_RE, 'date'));
  allEntities.push(...collectMatches(text, DATE_SLASH_RE, 'date'));
  allEntities.push(...collectMatches(text, DATE_ISO_RE, 'date'));
  allEntities.push(...collectMatches(text, EMAIL_RE, 'email'));
  allEntities.push(...collectMatches(text, PHONE_RE, 'phone'));

  // Dedupe overlapping spans, longest first
  allEntities.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const claimed: { start: number; end: number; placeholder: string }[] = [];
  for (const entity of allEntities) {
    if (overlaps(entity, claimed)) continue;
    // Never re-anonymize an existing placeholder
    if (/^\[[A-Z]+_\d+\]$/.test(entity.text)) continue;
    claimed.push({ start: entity.start, end: entity.end, placeholder: register(entity.text, entity.type) });
  }

  // Replace back-to-front so indices stay valid
  claimed.sort((a, b) => b.start - a.start);
  let result = text;
  for (const span of claimed) {
    result = result.slice(0, span.start) + span.placeholder + result.slice(span.end);
  }

  return { anonymizedText: result, mappings: registry.mappings, stats: registryStats(registry) };
}

/**
 * Reverse anonymization. Placeholders are processed longest-first so
 * `[PARTY_10]` is restored before `[PARTY_1]`.
 */
export function deanonymize(text: string, mappings: EntityMapping[]): string {
  const sorted = [...mappings].sort((a, b) => b.placeholder.length - a.placeholder.length);
  let result = text;
  for (const { placeholder, original } of sorted) {
    result = result.split(placeholder).join(original);
  }
  return result;
}
