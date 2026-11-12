import type { Agent, AgentStatus } from '../../shared/types';
import { Avatar } from './Avatar';

const NOTE: Record<AgentStatus, string> = { idle: '', thinking: 'working…', reviewing: 'reviewing…', blocked: 'needs your OK' };

/**
 * Everyone in the channel as a portrait (hover for the name and job). While an agent works, a lime line runs around
 * the edge of their portrait; an agent waiting on an approval gets a steady amber edge. The one speaking is lifted.
 */
export function Roster({ members, speakerId, onOpenAgent }: { members: Agent[]; speakerId?: string | null; onOpenAgent: (id: string) => void }) {
  return (
    <div className="roster" data-testid="roster" role="list" aria-label="Channel members">
      {members.map((a) => {
        const working = a.status === 'thinking' || a.status === 'reviewing';
        return (
          <button key={a.id} role="listitem" data-testid="roster-chip" data-status={a.status}
            className={`rchip${working ? ' working' : ''}${a.status === 'blocked' ? ' waiting' : ''}${a.id === speakerId ? ' speaking' : ''}`}
            onClick={() => onOpenAgent(a.id)} title={`${a.name} — ${a.role}${NOTE[a.status] ? ` (${NOTE[a.status]})` : ''}`}
            aria-label={`${a.name}, ${a.role}${NOTE[a.status] ? `, ${NOTE[a.status]}` : ''}`}>
            <span className="ring"><Avatar agent={a} size={32} /></span>
          </button>
        );
      })}
    </div>
  );
}
