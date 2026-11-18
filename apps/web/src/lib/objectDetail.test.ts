import { describe, expect, it } from 'vitest';
import { demoInventory } from '@dcat/test-fixtures';
import { objectLinks, objectMarkdown } from './objectDetail.ts';

const accountDlo = demoInventory.dlos[0]!;
const accountDmo = demoInventory.dmos.find((object) => object.apiName === 'Account_DMO__dlm')!;

describe('object detail helpers', () => {
  it('derives links only from metadata present in the snapshot', () => {
    const dloLinks = objectLinks(demoInventory, accountDlo);
    expect(dloLinks.mappings).toHaveLength(1);
    expect(dloLinks.mappings[0]).toMatchObject({ sourceObject: 'Account_DLO__dll', targetObject: 'Account_DMO__dlm' });
    expect(dloLinks.streams.map((stream) => stream.apiName)).toEqual(['Accounts_Stream']);
    expect(dloLinks.relationships).toHaveLength(0);

    const dmoLinks = objectLinks(demoInventory, accountDmo);
    expect(dmoLinks.mappings).toHaveLength(1);
    expect(dmoLinks.relationships).toHaveLength(4);
    expect(dmoLinks.relationships.map((edge) => edge.id)).toEqual(expect.arrayContaining([
      'order-account',
      'account-contact',
      'account-campaign',
      'case-account',
    ]));
    expect(dmoLinks.streams).toHaveLength(0);
  });

  it('builds a markdown summary without inventing transform links or leaking session data', () => {
    const markdown = objectMarkdown(accountDlo, 'dlo', objectLinks(demoInventory, accountDlo));
    expect(markdown).toContain('# Account DLO');
    expect(markdown).toContain('- Type: DLO');
    expect(markdown).toContain('- API name: `Account_DLO__dll`');
    expect(markdown).toContain('- Mappings: 1');
    expect(markdown).toContain('- Streams: 1');
    expect(markdown).toContain('## Fields');
    expect(markdown).toContain('`Id`');
    expect(markdown).not.toMatch(/token|password|session/i);
  });
});
