import { describe, expect, it } from 'vitest';
import { exportCsvTable } from './index.ts';

describe('exportCsvTable', () => {
  it('writes headers and rows with a trailing newline', () => {
    expect(exportCsvTable(['Name', 'Count'], [['Alpha', 1], ['Beta', 2]])).toBe('Name,Count\nAlpha,1\nBeta,2\n');
  });

  it('writes empty cells for null, undefined, and empty strings', () => {
    expect(exportCsvTable(['A', 'B', 'C'], [[null, undefined, '']])).toBe('A,B,C\n,,\n');
  });

  it('quotes commas, quotes, and newlines', () => {
    const csv = exportCsvTable(['Value'], [['a,b'], ['say "hi"'], ['line1\nline2']]);
    expect(csv).toBe('Value\n"a,b"\n"say ""hi"""\n"line1\nline2"\n');
  });

  it('neutralizes spreadsheet formulas without changing numbers', () => {
    const csv = exportCsvTable(['Value'], [
      ['=HYPERLINK("http://evil","click")'],
      ['+CMD'],
      ['-CMD'],
      ['@SUM'],
      [-42],
    ]);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(csv).toContain("'+CMD");
    expect(csv).toContain("'-CMD");
    expect(csv).toContain("'@SUM");
    expect(csv).toContain('-42');
  });

  it('renders booleans as words', () => {
    expect(exportCsvTable(['Flag'], [[true], [false]])).toBe('Flag\ntrue\nfalse\n');
  });
});
