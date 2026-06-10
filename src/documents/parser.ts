/**
 * Document intake — turn an uploaded file into text, then split that text
 * into provisions the engine can cite. Supports PDF, DOCX, Markdown and
 * plain text. Parsing libraries are loaded lazily so a missing optional
 * dependency degrades to a clear error instead of crashing the server.
 */

const TOPIC_KEYWORDS: Array<{ topic: string; patterns: RegExp }> = [
  { topic: 'geographic', patterns: /geograph|jurisdiction|emerging market|sub-saharan|region|territor/i },
  { topic: 'mfn', patterns: /most favou?red|\bmfn\b|compendium/i },
  { topic: 'co_invest', patterns: /co-invest|co invest|coinvest/i },
  { topic: 'fees', patterns: /management fee|carried interest|\bcarry\b|fee offset|preferred return/i },
  { topic: 'distributions', patterns: /distribution|waterfall|clawback|catch-?up/i },
  { topic: 'reporting', patterns: /report|financial statement|quarterly|annually|\bnav\b|valuation|statement of/i },
  { topic: 'key_person', patterns: /key person|key man|principal.{0,20}devote|investment period.{0,30}suspend/i },
  { topic: 'transfer', patterns: /transfer|assign|pledge|secondary/i },
  { topic: 'excuse', patterns: /excuse|excused|opt[- ]?out|exclud(e|ed)/i },
  { topic: 'advisory_board', patterns: /advisory board|\blpac\b|advisory committee/i },
  { topic: 'confidentiality', patterns: /confidential|non-?disclosure|proprietary/i },
  { topic: 'capital_calls', patterns: /capital call|drawdown|capital contribution|default(ing)? (limited )?partner/i },
  { topic: 'indemnification', patterns: /indemnif|exculpat|hold harmless/i },
  { topic: 'investment_restriction', patterns: /shall not invest|prohibited|restrict|excluded sector/i },
  { topic: 'notice', patterns: /\bnotice\b|notify|business days prior/i },
  { topic: 'consent', patterns: /consent|prior (written )?approval/i },
];

function classifyTopic(text: string): string {
  for (const { topic, patterns } of TOPIC_KEYWORDS) {
    if (patterns.test(text)) return topic;
  }
  return 'other';
}

export interface ParsedProvision {
  heading: string;
  topic: string;
  text: string;
}

/** Extract raw text from an uploaded document. */
export async function extractText(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const isPdf = mimeType.includes('pdf') || ext === 'pdf';
  const isDocx = mimeType.includes('officedocument.wordprocessing') || ext === 'docx';

  if (isPdf) {
    const { default: pdfParse } = (await import('pdf-parse/lib/pdf-parse.js')) as {
      default: (b: Buffer) => Promise<{ text: string }>;
    };
    const { text } = await pdfParse(buffer);
    return text;
  }
  if (isDocx) {
    const mammoth = (await import('mammoth')) as unknown as {
      extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
    };
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }
  // Markdown, plain text, or anything else readable as UTF-8
  return buffer.toString('utf-8');
}

// A line that opens with Section/Article/Clause/etc., or with a clause
// number, or an ALL-CAPS title, is treated as a heading.
const HEADING_KEYWORD = /^(?:section|article|clause|paragraph|schedule|annex|appendix|exhibit)\b/i;
const HEADING_NUMBERED = /^\d+(?:\.\d+)*[.)]?\s+\S/;
const HEADING_CAPS = /^[A-Z][A-Z0-9 \-&,'()]{3,70}$/;

function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 90) return false;
  if (HEADING_KEYWORD.test(t)) return true;
  if (HEADING_NUMBERED.test(t)) return true;
  if (HEADING_CAPS.test(t)) return true; // char class excludes lowercase, so this is a true all-caps line
  return false;
}

const MAX_PROVISIONS = 80;
const MAX_PROVISION_CHARS = 4000;

/**
 * Split document text into provisions. Prefers explicit headings (Section,
 * Article, numbered clauses, ALL-CAPS titles); falls back to paragraph
 * blocks when a document has no recognizable headings.
 */
export function chunkIntoProvisions(text: string): ParsedProvision[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } | null = null;
  let sawHeading = false;

  for (const line of lines) {
    if (looksLikeHeading(line)) {
      sawHeading = true;
      if (current) sections.push(current);
      current = { heading: line.trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      current = { heading: '', body: [line] };
    }
  }
  if (current) sections.push(current);

  let provisions: ParsedProvision[] = [];

  if (sawHeading) {
    for (const s of sections) {
      const body = s.body.join('\n').trim();
      if (!body && !s.heading) continue;
      const full = (s.heading ? `${s.heading}\n${body}` : body).trim();
      if (full.length < 25) continue;
      provisions.push({
        heading: s.heading || 'Untitled provision',
        topic: classifyTopic(full),
        text: full.slice(0, MAX_PROVISION_CHARS),
      });
    }
  } else {
    // No headings — break on blank-line paragraph blocks.
    const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length >= 40);
    provisions = blocks.map((b, i) => ({
      heading: `Clause ${i + 1}`,
      topic: classifyTopic(b),
      text: b.slice(0, MAX_PROVISION_CHARS),
    }));
  }

  return provisions.slice(0, MAX_PROVISIONS);
}

/** Guess document type from filename/content for nicer labelling. */
export function guessDocType(filename: string, text: string): 'lpa' | 'side_letter' | 'model_doc' {
  const hay = `${filename}\n${text.slice(0, 2000)}`.toLowerCase();
  if (/side letter/.test(hay)) return 'side_letter';
  if (/limited partnership agreement|\blpa\b|partnership agreement/.test(hay)) return 'lpa';
  return 'lpa';
}
