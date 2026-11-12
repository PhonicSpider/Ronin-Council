import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { prepareGitPublish } from '../electron/git';
import { Orchestrator } from '../electron/orchestrator';
import { ContentBlock, MockProvider, MockStepScript, StepResult } from '../electron/providers';
import { Store } from '../electron/store';
import { validateNoteRel } from '../electron/vault';
import { Channel } from '../shared/types';

const REPO = 'https://github.com/ronin/game';
const hasGit = spawnSync('git', ['--version']).status === 0;
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let dir = '';
let proj = '';
let bare = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-pub-'));
  proj = path.join(dir, 'proj');
  bare = path.join(dir, 'remote.git');
  fs.mkdirSync(proj);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** A project whose "origin" is a GitHub URL on paper but really pushes to a local bare repository (a separate push URL). */
function makeRepo() {
  git(dir, 'init', '--bare', '-b', 'main', bare);
  git(proj, 'init', '-b', 'main');
  git(proj, 'config', 'user.name', 'Test');
  git(proj, 'config', 'user.email', 't@example.com');
  git(proj, 'remote', 'add', 'origin', `${REPO}.git`);
  git(proj, 'config', 'remote.origin.pushurl', bare.split('\\').join('/')); // fetch URL stays the GitHub one; pushes land in the local bare repo
  git(proj, 'config', 'commit.gpgsign', 'false');
}
const pushed = () => spawnSync('git', ['--git-dir', bare, 'log', '--format=%s', 'main'], { encoding: 'utf8' }).stdout.trim();

describe.skipIf(!hasGit)('git_publish', () => {
  it('refuses unsafe or pointless situations with a message the agent can act on', () => {
    const err = (r: ReturnType<typeof prepareGitPublish>) => ('error' in r ? r.error : 'NO ERROR');
    expect(err(prepareGitPublish(proj, '', { message: 'x' }))).toMatch(/No GitHub repository is linked/);
    expect(err(prepareGitPublish(proj, REPO, { message: 'x' }))).toMatch(/not a git repository/);
    makeRepo();
    expect(err(prepareGitPublish(proj, REPO, {}))).toMatch(/message/);
    expect(err(prepareGitPublish(proj, REPO, { message: 'x'.repeat(501) }))).toMatch(/too long/);
    expect(err(prepareGitPublish(proj, 'https://github.com/someone/else', { message: 'x' }))).toMatch(/points to https:\/\/github.com\/ronin\/game/);
    fs.writeFileSync(path.join(proj, '.env'), 'KEY=1');
    expect(err(prepareGitPublish(proj, REPO, { message: 'x' }))).toMatch(/look like secrets.*\.env/);
    fs.rmSync(path.join(proj, '.env'));
    git(proj, 'remote', 'set-url', 'origin', 'https://gitlab.com/a/b.git');
    expect(err(prepareGitPublish(proj, REPO, { message: 'x' }))).toMatch(/not a GitHub repository/);
  });

  it('shows the exact files, branch and message, and does nothing until run', () => {
    makeRepo();
    fs.writeFileSync(path.join(proj, 'a.txt'), 'hello');
    const prep = prepareGitPublish(proj, REPO, { message: 'First commit' });
    if (!('action' in prep)) throw new Error(JSON.stringify(prep));
    expect(prep.action.tool).toBe('git_publish');
    expect(prep.action.preview).toContain(`Repository: ${REPO}`);
    expect(prep.action.preview).toContain('Branch: main (new on the remote)');
    expect(prep.action.preview).toContain('?? a.txt');
    expect(prep.action.preview).toContain('First commit');
    expect(pushed()).toBe('');
  });

  it('commits and pushes only what was approved, and a clean tree has nothing to publish', async () => {
    makeRepo();
    fs.writeFileSync(path.join(proj, 'a.txt'), 'hello');
    const prep = prepareGitPublish(proj, REPO, { message: 'First commit' });
    if (!('run' in prep)) throw new Error('no run: ' + JSON.stringify(prep));
    const out = await prep.run();
    expect(out.isError).toBeFalsy();
    expect(pushed()).toBe('First commit');
    expect('error' in prepareGitPublish(proj, REPO, { message: 'again' })).toBe(true); // up to date, clean

    fs.writeFileSync(path.join(proj, 'a.txt'), 'hello there');
    const second = prepareGitPublish(proj, REPO, { message: 'Second' });
    if (!('action' in second)) throw new Error('no action');
    expect(second.action.preview).toContain(' M a.txt');
    expect(second.action.preview).not.toMatch(/new on the remote/);
    expect((await second.run()).isError).toBeFalsy();
    expect(pushed().split('\n')).toEqual(['Second', 'First commit']);
  });

  it('refuses to run if the files changed after the user approved', async () => {
    makeRepo();
    fs.writeFileSync(path.join(proj, 'a.txt'), 'hello');
    const prep = prepareGitPublish(proj, REPO, { message: 'First' });
    if (!('run' in prep)) throw new Error('no run: ' + JSON.stringify(prep));
    fs.writeFileSync(path.join(proj, 'sneaky.txt'), 'added later');
    const out = await prep.run();
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/changed after you approved/);
    expect(pushed()).toBe('');
    expect(git(proj, 'rev-list', '--all', '--count')).toBe('0');
  });

  it('never carries shell characters from the message into a command', async () => {
    makeRepo();
    fs.writeFileSync(path.join(proj, 'a.txt'), 'hello');
    const evil = 'x"; echo pwned > pwned.txt; "';
    const prep = prepareGitPublish(proj, REPO, { message: evil });
    if (!('run' in prep)) throw new Error('no run: ' + JSON.stringify(prep));
    await prep.run();
    expect(fs.existsSync(path.join(proj, 'pwned.txt'))).toBe(false);
    expect(pushed()).toBe(evil);
  });
});

describe('save_note and git_publish through the agent loop', () => {
  const stepOf = (content: ContentBlock[], stopReason = 'end_turn'): StepResult => ({ content, stopReason, inTokens: 10, outTokens: 5 });
  const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: 'toolu_n', name, input });
  const until = async (cond: () => boolean, ms = 3000) => {
    const t = Date.now();
    while (!cond()) {
      if (Date.now() - t > ms) throw new Error('timed out waiting for condition');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  function setup(step: MockStepScript, withWrite = true) {
    const store = new Store();
    const written: Record<string, string> = {};
    const provider = new MockProvider(undefined, step);
    const orch = new Orchestrator(store, {
      getProvider: () => provider, vaultDigest: () => '(vault)',
      vaults: {
        hasNotes: () => true, list: () => [],
        read: (_c, rel) => { if (rel in written) return written[rel]!; throw new Error('not found'); },
        ...(withWrite ? { write: (_c: string, rel: string, content: string) => { written[rel] = content; } } : {}),
      },
    });
    const ch: Channel = store.channels().find((c) => c.categoryId === 'cat_1' && c.kind === 'general')!;
    return { store, provider, orch, ch, written };
  }
  const awaiting = (s: Store) => s.snapshot().notifications.find((n) => n.status === 'awaiting-user' && n.action);

  it('offers save_note only when vault writing exists, and tells the agent about it', async () => {
    const a = setup(() => stepOf([{ type: 'text', text: 'ok' }]));
    await a.orch.handleUserMessage(a.ch.id, '@Hex hi');
    expect(a.provider.stepCalls[0]!.tools.map((t) => t.name)).toEqual(['list_vault', 'read_vault', 'save_note']);
    expect(a.provider.stepCalls[0]!.system).toMatch(/save_note/);
    const b = setup(() => stepOf([{ type: 'text', text: 'ok' }]), false);
    await b.orch.handleUserMessage(b.ch.id, '@Hex hi');
    expect(b.provider.stepCalls[0]!.tools.map((t) => t.name)).toEqual(['list_vault', 'read_vault']);
    expect(b.provider.stepCalls[0]!.system).not.toMatch(/save_note/);
  });

  it('save_note: Widow audits, the user sees the exact text, and nothing is written until they approve', async () => {
    const t = setup((_r, n) => (n === 1 ? stepOf([use('save_note', { path: 'Reports/audit.md', content: '# Audit\nAll good.' })], 'tool_use') : undefined));
    const run = t.orch.handleUserMessage(t.ch.id, '@Hex write it up');
    await until(() => !!awaiting(t.store));
    const n = awaiting(t.store)!;
    expect(n.action).toMatchObject({ tool: 'save_note', summary: 'Save note Reports/audit.md to the Ronin Game vault' });
    expect(n.action!.preview).toContain('# Audit\nAll good.');
    expect(n.auditNote).toBeTruthy();
    expect(t.written).toEqual({});
    t.orch.resolveNotification(n.id, true);
    await run;
    expect(t.written['Reports/audit.md']).toBe('# Audit\nAll good.');
  });

  it('save_note: a no writes nothing; replacing an existing note shows a diff', async () => {
    const t = setup((_r, n) => {
      if (n === 1) return stepOf([use('save_note', { path: 'a.md', content: 'new text' })], 'tool_use');
      return undefined;
    });
    t.written['a.md'] = 'old text';
    const run = t.orch.handleUserMessage(t.ch.id, '@Hex update it');
    await until(() => !!awaiting(t.store));
    const n = awaiting(t.store)!;
    expect(n.action!.preview).toMatch(/REPLACES the existing note/);
    expect(n.action!.preview).toContain('-old text');
    expect(n.action!.preview).toContain('+new text');
    t.orch.resolveNotification(n.id, false);
    await run;
    expect(t.written['a.md']).toBe('old text');
  });

  it('save_note refuses paths that could harm the vault, without asking the user anything', async () => {
    const bad = ['../escape.md', '.obsidian/app.md', 'notes.txt', '_Other Vaults.md', 'a//b.md', 'C:\\x.md'];
    expect(() => validateNoteRel('Reports/ok.md')).not.toThrow();
    for (const p of bad) expect(() => validateNoteRel(p), p).toThrow();
    const results: ContentBlock[] = [];
    const t = setup((req, n) => {
      if (n <= bad.length) return stepOf([use('save_note', { path: bad[n - 1], content: 'x' })], 'tool_use');
      results.push(...(req.messages.at(-1)!.content as ContentBlock[]));
      return stepOf([{ type: 'text', text: 'done' }]);
    });
    await t.orch.handleUserMessage(t.ch.id, '@Hex go');
    expect(Object.keys(t.written)).toEqual([]);
    expect(t.store.snapshot().notifications.filter((x) => x.action)).toHaveLength(0);
  });

  it.skipIf(!hasGit)('git_publish is offered only with a linked repo, and pushes only after approval', async () => {
    makeRepo();
    fs.writeFileSync(path.join(proj, 'a.txt'), 'hello');
    let armed = false;
    let used = false;
    const t = setup(() => {
      if (armed && !used) { used = true; return stepOf([use('git_publish', { message: 'Agent commit' })], 'tool_use'); }
      return undefined;
    });
    t.store.setProjectPath('cat_1', proj);
    // No repo linked yet: the tool is not offered.
    await t.orch.handleUserMessage(t.ch.id, '@Hex hi');
    expect(t.provider.stepCalls[0]!.tools.map((x) => x.name)).not.toContain('git_publish');

    t.store.setRepoUrl('cat_1', REPO);
    armed = true;
    const run = t.orch.handleUserMessage(t.ch.id, '@Hex publish it');
    await until(() => !!awaiting(t.store));
    const n = awaiting(t.store)!;
    expect(t.provider.stepCalls.at(-1)!.tools.map((x) => x.name)).toContain('git_publish');
    expect(n.action).toMatchObject({ tool: 'git_publish' });
    expect(n.action!.preview).toContain('Agent commit');
    expect(pushed()).toBe('');
    t.orch.resolveNotification(n.id, true);
    await run;
    expect(pushed()).toBe('Agent commit');
  });
});
