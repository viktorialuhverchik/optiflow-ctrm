import { describe, expect, it } from 'vitest';
import { loadReferenceData } from './reference-files.js';

/**
 * The one test that touches the real data directory. It guards against drift in
 * the supplied CSVs: a new product or a changed column breaks this before it
 * breaks the extractor.
 */
describe('the supplied reference data', () => {
  const data = loadReferenceData('data');

  it('loads every product with a positive conversion factor', () => {
    expect(data.productCodes).toEqual([
      'FO35',
      'GAS95',
      'GO01',
      'JETA1',
      'LPGMIX',
      'NAPH',
      'ULSD10',
      'VLSFO',
    ]);
    for (const code of data.productCodes) {
      expect(data.products.get(code)?.bblPerMt.gt(0)).toBe(true);
    }
  });

  it('loads every quotation series', () => {
    expect(data.quoteCodes).toEqual([
      'ARGUS_CIF_NWE_NAPHTHA',
      'ARGUS_FOB_BLACK_SEA_FO_35',
      'PLATTS_CIF_NWE_ULSD_10PPM',
      'PLATTS_FOB_ARA_JET',
      'PLATTS_FOB_FUJ_VLSFO',
      'PLATTS_FOB_MED_ITALY_GASOIL_01',
    ]);
  });

  it('covers the dates the supplied recaps price against', () => {
    const gasoil = data.quotesByCode.get('PLATTS_FOB_MED_ITALY_GASOIL_01');
    expect(gasoil?.[0]?.date).toBe('2026-08-24');
    expect(gasoil?.[gasoil.length - 1]?.date).toBe('2026-10-30');
  });
});
