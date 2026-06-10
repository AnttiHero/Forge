import { describe, it, expect } from 'vitest';
import { chunkIntoProvisions, guessDocType } from './parser.js';

describe('chunkIntoProvisions', () => {
  it('splits on Section/Article headings and classifies topics', () => {
    const text = `Section 2.4 — Geographic Restrictions
The Partnership shall not invest more than 15% of aggregate Commitments outside North America and Europe.

Section 7.1 — Management Fee
During the Investment Period the management fee shall equal 2.0% per annum of aggregate Commitments.`;
    const provisions = chunkIntoProvisions(text);
    expect(provisions).toHaveLength(2);
    expect(provisions[0].heading).toContain('Geographic');
    expect(provisions[0].topic).toBe('geographic');
    expect(provisions[1].topic).toBe('fees');
    expect(provisions[0].text).toContain('15%');
  });

  it('falls back to paragraph blocks when there are no headings', () => {
    const text = `The General Partner shall deliver an annual report to each Limited Partner within ninety days.

No Limited Partner may transfer its interest without prior written consent of the General Partner.`;
    const provisions = chunkIntoProvisions(text);
    expect(provisions.length).toBe(2);
    expect(provisions[0].topic).toBe('reporting');
    expect(provisions[1].topic).toBe('transfer');
    expect(provisions[0].heading).toBe('Clause 1');
  });

  it('drops trivially short fragments', () => {
    const text = `OK

The Partnership shall maintain confidentiality of all non-public information received in connection with the fund.`;
    const provisions = chunkIntoProvisions(text);
    expect(provisions).toHaveLength(1);
    expect(provisions[0].topic).toBe('confidentiality');
  });

  it('caps the number of provisions', () => {
    const blocks = Array.from({ length: 200 }, (_, i) => `This is provision paragraph number ${i} about reporting duties and deadlines for the fund.`);
    const provisions = chunkIntoProvisions(blocks.join('\n\n'));
    expect(provisions.length).toBeLessThanOrEqual(80);
  });
});

describe('guessDocType', () => {
  it('detects side letters and LPAs', () => {
    expect(guessDocType('Norrland Side Letter.pdf', 'This Side Letter is entered into...')).toBe('side_letter');
    expect(guessDocType('fund-lpa.docx', 'Amended and Restated Limited Partnership Agreement')).toBe('lpa');
  });
});
