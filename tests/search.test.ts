import { describe, expect, it } from 'vitest';
import type { Agent, Channel, Message } from '../shared/types';
import { searchMessages, searchTerms, snippetAround } from '../src/search';

const ch = (id: string, name: string): Channel => ({ id, name, kind: 'chat', categoryId: 'c', memberIds: [], order: 0 } as unknown as Channel);
const msg = (id: string, channelId: string, content: string, ts: number, over: Partial<Message> = {}): Message =>
  ({ id, channelId, authorId: 'prog', kind: 'chat', content, ts, ...over } as Message);
const snap = {
  agents: [{ id: 'prog', name: 'Hex' }] as unknown as Agent[],
  channels: [ch('a', 'alpha'), ch('b', 'beta')],
  messages: [
    msg('1', 'a', 'The Database migration is ready', 1),
    msg('2', 'b', 'database backup finished, migration pending', 2),
    msg('3', 'a', 'you said hello', 3, { authorId: 'user' }),
    msg('4', 'a', 'database note from the system', 4, { authorId: 'system', kind: 'system' }),
  ],
};

describe('searchTerms', () => {
  it('lowercases, splits on spaces and caps the count', () => {
    expect(searchTerms('  Foo   BAR ')).toEqual(['foo', 'bar']);
    expect(searchTerms('a b c d e f g h i j')).toHaveLength(8);
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('searchMessages', () => {
  it('finds messages in every channel, newest first, ignoring case', () => {
    const hits = searchMessages(snap, 'DATABASE');
    expect(hits.map((h) => h.message.id)).toEqual(['2', '1']);
    expect(hits[0]!.channel.name).toBe('beta');
    expect(hits[0]!.authorName).toBe('Hex');
  });
  it('requires every word, in any order', () => {
    expect(searchMessages(snap, 'migration database').map((h) => h.message.id)).toEqual(['2', '1']);
    expect(searchMessages(snap, 'migration backup').map((h) => h.message.id)).toEqual(['2']);
  });
  it('skips system notes, labels the user "You", and returns nothing for a blank query', () => {
    expect(searchMessages(snap, 'system')).toEqual([]);
    expect(searchMessages(snap, 'hello')[0]!.authorName).toBe('You');
    expect(searchMessages(snap, '  ')).toEqual([]);
  });
  it('respects the limit', () => {
    expect(searchMessages(snap, 'database', 1)).toHaveLength(1);
  });
  it('splits the snippet around the match so it can be highlighted', () => {
    const h = searchMessages(snap, 'migration')[0]!;
    expect(h.before + h.match + h.after).toContain('migration');
    expect(h.match.toLowerCase()).toBe('migration');
  });
});

describe('snippetAround', () => {
  it('adds ellipses and cuts on word edges for long text', () => {
    const text = 'word '.repeat(60) + 'NEEDLE ' + 'tail '.repeat(60);
    const s = snippetAround(text, text.indexOf('NEEDLE'), 6);
    expect(s.match).toBe('NEEDLE');
    expect(s.before.startsWith('…')).toBe(true);
    expect(s.after.endsWith('…')).toBe(true);
    expect(s.before.length + s.after.length).toBeLessThan(160);
  });
});
