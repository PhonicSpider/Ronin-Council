// git_publish: commit the project's changes and push the current branch to the project's linked GitHub repository.
// It is deliberately narrower than run_command: it can only push to the repo linked in Settings, only the branch that is
// already checked out, never forces, refuses files that look like secrets, and shows the exact file list for approval.
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeRepoUrl } from './attachments';
import type { Prepared, ToolDef, ToolOutput } from './project';
import { isSensitive, killTree, MAX_PREVIEW, scrubbedEnv, visible } from './project';

export const GIT_TOOL: ToolDef = {
  name: 'git_publish',
  description:
    'Commit ALL current changes in the project folder with your message and push the checked-out branch to the project\'s linked GitHub repository. ' +
    'REQUIRES approval: Widow audits it and the user sees the exact files, branch and commit message first. Never forces, never touches other remotes, ' +
    'and refuses files that look like secrets. Use it only when the user asked to publish or update the repo.',
  input_schema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Commit message: a short summary line, optionally a blank line and detail (max 500 characters)' } },
    required: ['message'], additionalProperties: false,
  },
};

const MAX_FILES = 300;
const GIT_TIMEOUT = 20_000;
const PUSH_TIMEOUT = 120_000;

const gitEnv = (): NodeJS.ProcessEnv => ({ ...scrubbedEnv(), GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' });

function gitSync(root: string, args: string[], trim = true): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: root, env: gitEnv(), encoding: 'utf8', timeout: GIT_TIMEOUT, windowsHide: true, maxBuffer: 10_000_000 });
  if (r.error) {
    const missing = (r.error as NodeJS.ErrnoException).code === 'ENOENT';
    return { ok: false, out: missing ? 'git is not installed or not on the PATH' : r.error.message };
  }
  const out = `${r.stdout ?? ''}${r.status === 0 ? '' : r.stderr ?? ''}`;
  return { ok: r.status === 0, out: trim ? out.trim() : out };
}

function runGit(root: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn('git', args, { cwd: root, env: gitEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (d: Buffer) => { if (out.length < 20_000) out += d.toString('utf8'); };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const done = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, out: `${out.trim()}${extra}` });
    };
    const kill = (why: string) => { killTree(child.pid, () => child.kill('SIGKILL')); setTimeout(() => done(null, `\n[${why}]`), 1500); };
    const timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    const onAbort = () => kill('stopped by the user');
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => done(null, `\n[could not start git: ${e.message}]`));
    child.on('close', (code) => done(code));
  });
}

interface Change { code: string; path: string }

/** `git status` as a list of [XY, path] (renames show the new path). */
function changes(root: string): Change[] {
  const r = gitSync(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], false); // not trimmed: the first status code can start with a space
  if (!r.ok) throw new Error(`git status failed: ${r.out}`);
  const parts = r.out.split('\0').filter(Boolean);
  const list: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!.slice(0, 2);
    list.push({ code, path: parts[i]!.slice(3) });
    if (code[0] === 'R' || code[0] === 'C') i++; // the next entry is the old name
  }
  return list;
}

const signature = (list: Change[]) => list.map((c) => `${c.code}${c.path}`).sort().join('\n');

/** Everything that must be true before anything is shown for approval. Throws a message the agent can act on. */
export function prepareGitPublish(root: string, repoUrl: string, input: unknown): Prepared {
  try {
    return prepare(root, repoUrl, input);
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function prepare(root: string, repoUrl: string, input: unknown): Prepared {
  if (!repoUrl) throw new Error('No GitHub repository is linked to this project. The user can add one in Settings → Vaults & Projects.');
  const raw = (input as { message?: unknown } | null)?.message;
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('"message" (the commit message) is required');
  const message = raw.trim();
  if (message.length > 500) throw new Error('The commit message is too long (500 characters max)');

  const top = gitSync(root, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new Error(`The project folder is not a git repository (${top.out.split('\n')[0]}). Run "git init" and add the remote first.`);
  if (path.resolve(fs.realpathSync.native(top.out)).toLowerCase() !== path.resolve(fs.realpathSync.native(root)).toLowerCase()) {
    throw new Error('The project folder is inside a larger git repository; publishing from here is not supported.');
  }
  const remote = gitSync(root, ['remote', 'get-url', 'origin']);
  if (!remote.ok) throw new Error('This repository has no "origin" remote. Add one that points to the linked GitHub repository.');
  let origin: string;
  try { origin = normalizeRepoUrl(remote.out); } catch { throw new Error(`The "origin" remote (${visible(remote.out)}) is not a GitHub repository.`); }
  if (origin.toLowerCase() !== repoUrl.toLowerCase()) {
    throw new Error(`"origin" points to ${origin}, but this project's linked repository is ${repoUrl}. Nothing was pushed.`);
  }
  const head = gitSync(root, ['symbolic-ref', '--short', 'HEAD']);
  if (!head.ok) throw new Error('HEAD is detached (not on a branch). Check out a branch first.');
  const branch = head.out;
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.startsWith('-') || branch.includes('..')) throw new Error(`Unsupported branch name "${visible(branch)}".`);

  const list = changes(root);
  const unpushed = gitSync(root, ['rev-list', '--count', `origin/${branch}..HEAD`]);
  const ahead = unpushed.ok ? Number(unpushed.out) || 0 : -1; // -1: the branch is not on the remote yet
  if (list.length === 0 && ahead === 0) throw new Error('Nothing to commit or push: the working tree is clean and the branch is up to date.');
  if (list.length > MAX_FILES) throw new Error(`${list.length} files changed; too many to review in one go (limit ${MAX_FILES}). Commit in smaller pieces.`);
  const secrets = list.filter((c) => isSensitive(c.path));
  if (secrets.length) {
    throw new Error(`These files look like secrets and will not be committed: ${secrets.map((c) => c.path).join(', ')}. Add them to .gitignore first.`);
  }

  const stat = list.length ? gitSync(root, ['diff', 'HEAD', '--stat', '--no-color']).out : '';
  const preview = [
    `Repository: ${repoUrl}`,
    `Branch: ${branch}${ahead === -1 ? ' (new on the remote)' : ahead > 0 ? ` (${ahead} commit(s) already waiting to be pushed)` : ''}`,
    `Commit message:\n${visible(message)}`,
    '',
    list.length ? `Files to commit (${list.length}):\n${list.map((c) => `${c.code} ${visible(c.path)}`).join('\n')}` : 'No new changes to commit; only the waiting commits will be pushed.',
    stat ? `\nSummary of tracked changes:\n${stat}` : '',
    '\nThis commits everything listed above and pushes the branch. It never forces.',
  ].join('\n');
  if (preview.length > MAX_PREVIEW) throw new Error('The change list is too long to review in full. Commit in smaller pieces.');

  const approved = signature(list);
  return {
    needsApproval: true,
    label: `committed and pushed ${branch} to ${repoUrl.replace('https://github.com/', '')}`,
    action: { tool: 'git_publish', summary: `Commit and push "${branch}" to ${repoUrl.replace('https://github.com/', '')}`, preview },
    run: async (signal) => {
      // Files may have changed between the approval and now. Only what was shown is allowed to go.
      let now: Change[];
      try { now = changes(root); } catch (e) { return { text: (e as Error).message, isError: true }; }
      if (signature(now) !== approved) {
        return { text: 'The files changed after you approved, so nothing was committed. Ask again to review the new list.', isError: true };
      }
      const log: string[] = [];
      const step = async (args: string[], timeout: number): Promise<boolean> => {
        const r = await runGit(root, args, timeout, signal);
        log.push(`$ git ${args[0]}${args[0] === 'commit' ? ' -m …' : ' ' + args.slice(1).join(' ')}\n${r.out || '(no output)'}`);
        return r.code === 0;
      };
      if (list.length) {
        if (!(await step(['add', '-A'], PUSH_TIMEOUT)) || !(await step(['commit', '-m', message], PUSH_TIMEOUT))) {
          return finish(log, false);
        }
      }
      const pushArgs = ahead === -1 ? ['push', '-u', 'origin', branch] : ['push', 'origin', branch];
      return finish(log, await step(pushArgs, PUSH_TIMEOUT));
    },
  };
}

function finish(log: string[], ok: boolean): ToolOutput {
  const text = `${ok ? 'Done.' : 'Failed.'}\n${log.join('\n\n')}`;
  return { text, detail: text, isError: !ok };
}
