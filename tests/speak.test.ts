import { describe, expect, it } from 'vitest';
import type { Message } from '../shared/types';
import { isSpoken, revealText, speakDuration } from '../src/speak';

const msg = (over: Partial<Message>): Message => ({
  id: 'm1', channelId: 'c1', authorId: 'prog', kind: 'chat', content: 'hello there', ts: 1, ...over,
} as Message);

describe('speakDuration', () => {
  it('scales with length between 0.6 s and 3.2 s', () => {
    expect(speakDuration(5)).toBe(600);
    expect(speakDuration(100)).toBe(1400);
    expect(speakDuration(5000)).toBe(3200);
  });
  it('speeds up when several replies are waiting', () => {
    expect(speakDuration(100, 2)).toBeLessThan(speakDuration(100, 0));
    expect(speakDuration(100, 3)).toBeLessThan(speakDuration(100, 2));
  });
});

describe('revealText', () => {
  it('shows nothing at the start and everything at the end', () => {
    expect(revealText('hello world', 0)).toBe('');
    expect(revealText('hello world', 1)).toBe('hello world');
    expect(revealText('hello world', 2)).toBe('hello world');
  });
  it('cuts at a word boundary instead of mid-word', () => {
    expect(revealText('the quick brown fox jumps', 0.5)).toBe('the quick');
  });
  it('closes an unfinished code fence so the partial text still renders', () => {
    const out = revealText('Here:\n```ts\nconst a = 1;\nconst b = 2;\n```\ndone', 0.5);
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
  });
});

describe('isSpoken', () => {
  const agents = new Set(['prog', 'widow']);
  it('speaks agent chat, deliverables and reviews', () => {
    expect(isSpoken(msg({}), agents)).toBe(true);
    expect(isSpoken(msg({ kind: 'deliverable' }), agents)).toBe(true);
    expect(isSpoken(msg({ kind: 'review' }), agents)).toBe(true);
  });
  it('does not hold back the user, tool rows, system notes or empty messages', () => {
    expect(isSpoken(msg({ authorId: 'user' }), agents)).toBe(false);
    expect(isSpoken(msg({ kind: 'tool' }), agents)).toBe(false);
    expect(isSpoken(msg({ kind: 'system' }), agents)).toBe(false);
    expect(isSpoken(msg({ content: '   ' }), agents)).toBe(false);
  });
});
