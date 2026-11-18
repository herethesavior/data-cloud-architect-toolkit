import { describe, expect, it } from 'vitest';
import { redactSensitive } from './redact.ts';

describe('redactSensitive', () => {
  it('redacts access token JSON fields', () => {
    const output = '{"result":{"accessToken":"00Dd200000Li8SP!AQEAQOZ_1ZzpzaDXV"}}';
    const redacted = redactSensitive(output);
    expect(redacted).toContain('"accessToken":"[REDACTED]"');
    expect(redacted).not.toContain('AQEAQOZ');
    expect(() => JSON.parse(redacted)).not.toThrow();
  });

  it('redacts auth URLs and bearer values', () => {
    expect(redactSensitive('force://PlatformCLI:secret@demo.my.salesforce.com')).not.toContain('secret@');
    expect(redactSensitive('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456')).toContain('[REDACTED]');
  });

  it('keeps non-sensitive CLI text intact', () => {
    expect(redactSensitive('Connected')).toBe('Connected');
  });
});
