import { describe, it, expect } from 'vitest';
import { anonymize, createRegistry, deanonymize } from './anonymize.js';

describe('anonymize', () => {
  it('replaces typed terms and amounts, and roundtrips', () => {
    const text =
      'Vulcan Industrial Partners III, L.P. will accept a commitment of $150,000,000 from Norrland Pension AB on March 15, 2026.';
    const result = anonymize(text, [
      { term: 'Vulcan Industrial Partners III, L.P.', type: 'fund' },
      { term: 'Norrland Pension AB', type: 'investor' },
    ]);
    expect(result.anonymizedText).toContain('[FUND_1]');
    expect(result.anonymizedText).toContain('[INVESTOR_1]');
    expect(result.anonymizedText).toContain('[AMOUNT_1]');
    expect(result.anonymizedText).toContain('[DATE_1]');
    expect(result.anonymizedText).not.toContain('Vulcan');
    expect(result.anonymizedText).not.toContain('Norrland');
    expect(deanonymize(result.anonymizedText, result.mappings)).toBe(text);
  });

  it('prefers longest term so Fund III is not split', () => {
    const result = anonymize('Vulcan Industrial Partners III follows Vulcan Industrial Partners.', [
      { term: 'Vulcan Industrial Partners III', type: 'fund' },
      { term: 'Vulcan Industrial Partners', type: 'fund' },
    ]);
    expect(result.anonymizedText).toBe('[FUND_1] follows [FUND_2].');
  });

  it('keeps placeholders stable across calls with a shared registry', () => {
    const registry = createRegistry();
    const a = anonymize('Norrland Pension AB objects.', [{ term: 'Norrland Pension AB', type: 'investor' }], registry);
    const b = anonymize('We replied to Norrland Pension AB.', [{ term: 'Norrland Pension AB', type: 'investor' }], registry);
    expect(a.anonymizedText).toContain('[INVESTOR_1]');
    expect(b.anonymizedText).toContain('[INVESTOR_1]');
    expect(registry.mappings).toHaveLength(1);
  });

  it('restores [PARTY_10] before [PARTY_1] (no partial replacement)', () => {
    const mappings = [];
    for (let i = 1; i <= 10; i++) {
      mappings.push({ placeholder: `[PARTY_${i}]`, original: `Company ${i}`, type: 'party' as const });
    }
    const restored = deanonymize('[PARTY_10] sued [PARTY_1].', mappings);
    expect(restored).toBe('Company 10 sued Company 1.');
  });

  it('never treats role words as names', () => {
    const result = anonymize('The General Partner manages the Fund.', [
      { term: 'General Partner', type: 'party' },
      { term: 'Fund', type: 'fund' },
    ]);
    expect(result.anonymizedText).toBe('The General Partner manages the Fund.');
  });

  it('does not re-anonymize existing placeholders', () => {
    const result = anonymize('[FUND_1] commits $5,000,000.', [{ term: '[FUND_1]', type: 'fund' }]);
    expect(result.anonymizedText).toContain('[FUND_1]');
    expect(result.anonymizedText).toContain('[AMOUNT_1]');
  });
});
