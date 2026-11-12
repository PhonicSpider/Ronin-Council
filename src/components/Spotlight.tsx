import type { Agent } from '../../shared/types';
import type { SpeakPhase } from '../speak';
import { Avatar } from './Avatar';

/** The agent who is speaking right now, shown large above the composer like a character in a visual novel. */
export function Spotlight({ agent, phase, onSkip }: { agent: Agent; phase: Exclude<SpeakPhase, null>; onSkip: () => void }) {
  return (
    <div className={`spotlight ${phase}`} data-testid="spotlight" data-agent={agent.id} aria-hidden="true"
      style={{ '--agent': agent.color } as React.CSSProperties} onClick={onSkip} title="Click to skip ahead">
      <div className="spot-frame"><Avatar agent={agent} size={150} /></div>
      <div className="spot-name"><strong>{agent.name}</strong><small>{agent.role}</small></div>
    </div>
  );
}
