import { Agent, Channel, ChannelKind } from '../shared/types';

/**
 * "Go to your own channels": in a category's #general, @security / @design / @networking ... name a *team*, not an agent.
 * This turns such a message into one job per target channel. It is deliberately plain string handling (no model call),
 * so what gets sent where is predictable and free.
 */

interface Alias { words: RegExp; kind: ChannelKind; role: RegExp }

// Words people naturally use for the teams that exist by default. A channel whose name equals the word also works on its own.
const ALIASES: Alias[] = [
  { words: /^(security|sec|infosec|secure)$/i, kind: 'engineering', role: /security/i },
  { words: /^(cloud|aws|azure|gcp|saas|integrations?|apis?|devops|hosting|deploy(ment)?|cicd|ci-cd)$/i, kind: 'engineering', role: /cloud/i },
  { words: /^(network(ing)?|net|servers?|backend|back-end|infra(structure)?|dedicated)$/i, kind: 'engineering', role: /engineer/i },
  { words: /^(engineering|engineers?)$/i, kind: 'engineering', role: /engineer/i },
  { words: /^(design|designers?|ux|ui|frontend|front-end|interface)$/i, kind: 'design', role: /ux|design/i },
  { words: /^(art|artists?|assets|visuals?)$/i, kind: 'art', role: /art/i },
  { words: /^(research|researchers?)$/i, kind: 'research', role: /research/i },
  { words: /^(programming|programmers?|code|coding|dev|devs|developers?|qa|test|testing)$/i, kind: 'programming', role: /programming|qa|test/i },
];

/** The most agents sent into one channel by name-matching; keeps a mission from becoming a crowd. */
const MAX_TEAM = 4;

export interface Job {
  channel: Channel;
  /** Agents who speak first (empty = let Widow route inside the channel). */
  team: Agent[];
  /** What the user typed for this team, in order. */
  tokens: string[];
  tasks: string[];
}

export interface DelegationPlan {
  preface: string;
  jobs: Job[];
  /** @words that matched neither an agent, a channel nor a known team. */
  unresolved: string[];
}

type Kind = { t: 'agent' } | { t: 'unknown' } | { t: 'job'; channel: Channel; role: RegExp | null };

function classify(word: string, general: Channel, channels: Channel[], agents: Agent[]): Kind {
  const w = word.toLowerCase();
  if (agents.some((a) => a.name.toLowerCase() === w)) return { t: 'agent' }; // ordinary @mention of a person
  const alias = ALIASES.find((a) => a.words.test(word));
  const byName = channels.find((c) => c.id !== general.id && c.kind !== 'dm' && c.name.toLowerCase() === w);
  const channel = byName ?? (alias ? channels.find((c) => c.id !== general.id && c.kind === alias.kind) : undefined);
  if (channel) return { t: 'job', channel, role: alias && alias.kind === channel.kind ? alias.role : null };
  if (w === 'general' || w === general.name.toLowerCase()) return { t: 'agent' }; // pointing at this very channel: nothing to send
  return { t: 'unknown' };
}

const clean = (s: string) => s.replace(/^[\s,:;.\-–—]+/, '').trim();

/** Returns null when the message names no team (so it is handled as an ordinary message). */
export function planDelegation(text: string, general: Channel, channels: Channel[], agents: Agent[]): DelegationPlan | null {
  if (general.kind !== 'general' || !general.categoryId) return null;
  const marks: { start: number; end: number; word: string; kind: Kind }[] = [];
  // An "@word" counts only at a word boundary, so addresses like name@host.com are left alone.
  const re = /(^|[^\w@])@([A-Za-z][\w-]*)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[1]!.length;
    marks.push({ start, end: start + 1 + m[2]!.length, word: m[2]!, kind: classify(m[2]!, general, channels, agents) });
  }
  const bounds = marks.filter((m) => m.kind.t !== 'agent');
  if (!bounds.some((b) => b.kind.t === 'job')) return null;

  const preface = clean(text.slice(0, bounds[0]!.start));
  const byChannel = new Map<string, Job>();
  const unresolved: string[] = [];
  bounds.forEach((b, i) => {
    if (b.kind.t === 'unknown') { if (!unresolved.includes(b.word.toLowerCase())) unresolved.push(b.word.toLowerCase()); return; }
    if (b.kind.t !== 'job') return;
    const task = clean(text.slice(b.end, bounds[i + 1]?.start ?? text.length));
    let job = byChannel.get(b.kind.channel.id);
    if (!job) { job = { channel: b.kind.channel, team: [], tokens: [], tasks: [] }; byChannel.set(b.kind.channel.id, job); }
    job.tokens.push(`@${b.word}`);
    job.tasks.push(task || preface || 'Take a look and tell me what you find.');
    const role = b.kind.role;
    if (role) {
      for (const id of b.kind.channel.memberIds) {
        const a = agents.find((x) => x.id === id);
        if (a && role.test(a.role) && !job.team.some((t) => t.id === a.id)) job.team.push(a);
      }
    }
  });
  for (const j of byChannel.values()) j.team = j.team.slice(0, MAX_TEAM);
  return { preface, jobs: [...byChannel.values()], unresolved };
}

/** The message that opens the work in the target channel. */
export function briefText(general: Channel, job: Job, preface: string, canSave = false): string {
  const body = job.tasks.length === 1
    ? job.tasks[0]!
    : job.tasks.map((t, i) => `- (${job.tokens[i]}) ${t}`).join('\n');
  const lead = preface && !job.tasks.includes(preface) ? `Context from the user: ${preface}\n\n` : '';
  return (
    `Task from #${general.name}:\n${lead}${body}\n\n` +
    `Work this out here with your teammates: split it up, @mention each other, use your tools on the project.\n\n` +
    `Done when: the first of you to speak starts with one line beginning "Done when:" that says, in checkable terms, what finished looks like ` +
    `(for example "the failing test passes", "every endpoint is reviewed", "a plan is saved"). Keep to it. ` +
    `Finish with a short statement of what you found or did, say for each "Done when" point whether it was met (met / not met, and why), ` +
    `and name anything that still needs the user.` +
    (canSave ? ` If the result is worth keeping, one of you can save a short note to the project vault with save_note.` : '')
  );
}
