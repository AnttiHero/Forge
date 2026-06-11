/**
 * Privacy gateway — every byte that leaves the machine passes through here.
 *
 * Pipeline: regex anonymization (defined terms = every fund and investor
 * name in the ontology) → local-model NER assist to catch names regex
 * missed → reversible placeholder mappings. Mappings are sticky per run,
 * so [INVESTOR_3] means the same LP across all calls of one pipeline run.
 *
 * If Ollama is down the NER pass is skipped (nerUsed: false) and the
 * regex pass alone carries the call — degraded, never blocked.
 */

import { config } from '../config.js';
import { getDb } from '../db/db.js';
import {
  anonymize,
  createRegistry,
  deanonymize,
  registryStats,
  type AnonymizationRegistry,
  type EntityMapping,
  type EntityType,
  type TypedTerm,
} from '../privacy/anonymize.js';
import * as ollama from './ollama.js';

export interface SanitizeResult {
  sanitized: string;
  mappings: EntityMapping[];
  stats: Record<EntityType, number>;
  nerUsed: boolean;
}

const runRegistries = new Map<string, AnonymizationRegistry>();

/** Drop a run's mapping context once the pipeline finishes. */
export function releaseRun(runId: string): void {
  runRegistries.delete(runId);
}

/** Reset all run contexts (tests). */
export function resetGateway(): void {
  runRegistries.clear();
}

/** How many run registries are alive (tests — leak detection). */
export function activeRunCount(): number {
  return runRegistries.size;
}

export function getRegistry(runId?: string): AnonymizationRegistry {
  if (!runId) return createRegistry();
  let reg = runRegistries.get(runId);
  if (!reg) {
    reg = createRegistry();
    runRegistries.set(runId, reg);
  }
  return reg;
}

/** Generic words that must not become aliases on their own. */
const ALIAS_STOPWORDS = new Set([
  'state',
  'county',
  'university',
  'fund',
  'funds',
  'capital',
  'pension',
  'mutual',
  'partners',
  'industrial',
  'investment',
  'development',
  'finance',
  'insurance',
  'retirement',
  'teachers',
  'employees',
  'company',
  'authority',
  'trust',
  'holdings',
]);

/** Short forms people actually write: "Norrland" for "Norrland Pension AB". */
function aliasesFor(name: string): string[] {
  const words = name.replace(/[(),]/g, ' ').split(/\s+/).filter(Boolean);
  const aliases: string[] = [];
  const first = words[0];
  if (first && first.length >= 5 && !ALIAS_STOPWORDS.has(first.toLowerCase())) aliases.push(first);
  if (words.length >= 2) {
    const firstTwo = `${words[0]} ${words[1]}`;
    if (firstTwo.length < name.length) aliases.push(firstTwo);
  }
  return aliases;
}

/** Fund and investor names the ontology knows — plus derived short-form
 *  aliases so "Norrland" masks even when "Norrland Pension AB" doesn't
 *  appear in full.
 *
 *  When `scopeFundId` is given, only that matter's fund name and the
 *  investors committed to it are used as defined terms. This avoids
 *  cross-matter collisions (e.g. an unrelated "Meridian State Pension" in
 *  one matter being masked — and wrongly restored — via a seed investor's
 *  "Meridian" alias from another). Names the scoped list misses are still
 *  caught by the local NER pass. With no scope, all names are used (right
 *  for cross-fund queries like the obligations register). */
function confidentialTerms(scopeFundId?: string): TypedTerm[] {
  const db = getDb();
  const terms: TypedTerm[] = [];
  const add = (name: string, type: TypedTerm['type']): void => {
    terms.push({ term: name, type });
    for (const alias of aliasesFor(name)) terms.push({ term: alias, type });
  };
  if (scopeFundId) {
    const fund = db.prepare('SELECT name FROM funds WHERE id = ?').get(scopeFundId) as { name: string } | undefined;
    if (fund) add(fund.name, 'fund');
    // every investor the matter touches — commitments alone misses BYO LPs
    // whose documents/comments arrived before (or without) a commitment row
    const investors = db
      .prepare(
        `SELECT name FROM investors WHERE id IN (
           SELECT investor_id FROM commitments WHERE fund_id = ?
           UNION SELECT investor_id FROM documents WHERE fund_id = ? AND investor_id IS NOT NULL
           UNION SELECT investor_id FROM comments WHERE fund_id = ?
           UNION SELECT investor_id FROM side_letters WHERE fund_id = ?
         )`,
      )
      .all(scopeFundId, scopeFundId, scopeFundId, scopeFundId) as Array<{ name: string }>;
    for (const i of investors) add(i.name, 'investor');
    return terms;
  }
  const funds = db.prepare('SELECT name FROM funds').all() as Array<{ name: string }>;
  for (const f of funds) add(f.name, 'fund');
  const investors = db.prepare('SELECT name FROM investors').all() as Array<{ name: string }>;
  for (const i of investors) add(i.name, 'investor');
  return terms;
}

const NER_SYSTEM = `You are a named-entity scanner for a law firm's privacy gateway. The user message is legal text in which known confidential names have already been replaced by [BRACKET_N] placeholders. List any REMAINING named entities that could identify a party: organization names, person names, or place names tied to a specific party. Ignore generic roles (General Partner, Limited Partner, the Fund), legal terms, placeholders, and geographic regions used as investment categories (e.g. "sub-Saharan Africa", "emerging markets"). Respond ONLY with JSON: {"entities": [{"text": "exact text as it appears", "type": "party"}]}. Return {"entities": []} if none remain.`;

const MAX_NER_ENTITIES = 20;

interface NerCandidate {
  text: string;
  type: string;
}

/**
 * Sanitize text before it leaves the machine.
 */
export async function sanitizeOutbound(
  text: string,
  runId?: string,
  scopeFundId?: string,
  protectNames?: string[],
): Promise<SanitizeResult> {
  const registry = getRegistry(runId);
  const terms = confidentialTerms(scopeFundId);
  // Caller-supplied names (e.g. an LP not yet linked to the fund by any
  // table) get the same treatment as ontology terms, aliases included
  for (const name of protectNames ?? []) {
    const trimmed = name.trim();
    if (trimmed.length < 3) continue;
    terms.push({ term: trimmed, type: 'investor' });
    for (const alias of aliasesFor(trimmed)) terms.push({ term: alias, type: 'investor' });
  }
  // Previously-seen originals must keep mapping in new text
  for (const m of registry.mappings) {
    if (m.type === 'fund' || m.type === 'investor' || m.type === 'party') {
      terms.push({ term: m.original, type: m.type });
    }
  }

  // Pass 1: regex with ontology-defined terms
  let { anonymizedText } = anonymize(text, terms, registry);
  let nerUsed = false;

  // Pass 2: local-model NER assist
  if (await ollama.isUp()) {
    try {
      const raw = (await ollama.chatJson(NER_SYSTEM, anonymizedText.slice(0, 8_000))) as {
        entities?: NerCandidate[];
      };
      const candidates = (raw.entities ?? [])
        .filter((e): e is NerCandidate => typeof e?.text === 'string' && e.text.length >= 3)
        .slice(0, MAX_NER_ENTITIES);
      const verified: TypedTerm[] = [];
      // Candidates must exist OUTSIDE existing placeholders — the local model
      // sometimes returns a placeholder's innards ("INVESTOR_1") as an
      // "entity", and re-masking that nests mappings that can't be restored.
      const outsidePlaceholders = anonymizedText.replace(/\[[A-Z]+_\d+\]/g, ' ');
      for (const c of candidates) {
        if (!outsidePlaceholders.includes(c.text)) continue;
        if (/[A-Z]+_\d+/.test(c.text)) continue;
        verified.push({ term: c.text, type: 'party' });
      }
      if (verified.length > 0) {
        anonymizedText = anonymize(anonymizedText, verified, registry).anonymizedText;
      }
      nerUsed = true;
    } catch {
      nerUsed = false; // NER assist failed — regex-only is still a valid result
    }
  }

  return {
    sanitized: anonymizedText,
    mappings: registry.mappings,
    stats: registryStats(registry),
    nerUsed,
  };
}

/**
 * Restore originals in a frontier response — deep-walks every string field
 * so placeholders inside nested structured output (including citation
 * quotes) come back as real names.
 */
/** What may be said about an investor next to its masked name. Type alone
 *  by default; jurisdiction only when explicitly enabled — the pair can
 *  re-identify an LP by structure in a small fund. */
export function investorProfile(type: string, jurisdiction: string): string {
  const t = type.replace(/_/g, ' ');
  return config.privacy.sendJurisdiction && jurisdiction ? `${t}, ${jurisdiction}` : t;
}

export function restoreInbound<T>(value: T, mappings: EntityMapping[]): T {
  if (typeof value === 'string') {
    return deanonymize(value, mappings) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => restoreInbound(v, mappings)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = restoreInbound(v, mappings);
    }
    return out as unknown as T;
  }
  return value;
}
