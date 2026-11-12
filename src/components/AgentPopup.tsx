import { useEffect, useState } from 'react';
import type { AgentStatus, Snapshot, Tier } from '../../shared/types';
import { WIDOW_ID } from '../../shared/types';
import { act } from '../api';
import { Avatar } from './Avatar';
import { ModelPicker } from './ModelPicker';
import { AvatarEditor } from './AvatarEditor';

const STATUS: Record<AgentStatus, string> = {
  idle: 'Idle', thinking: 'Thinking', reviewing: 'Reviewing', blocked: 'Blocked / waiting',
};
export { TIER_LABEL } from './ModelPicker';

export function AgentPopup({ snap, agentId, onClose }: { snap: Snapshot; agentId: string; onClose: () => void }) {
  const agent = snap.agents.find((a) => a.id === agentId);
  const [name, setName] = useState(agent?.name ?? '');
  const [personality, setPersonality] = useState(agent?.personality ?? '');
  const [specialty, setSpecialty] = useState(agent?.specialty ?? '');

  // Reset the form only when switching agents, so incoming snapshots never clobber what is being typed.
  useEffect(() => {
    setName(agent?.name ?? ''); setPersonality(agent?.personality ?? ''); setSpecialty(agent?.specialty ?? '');
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [editing, setEditing] = useState(false);
  useEffect(() => {
    // While the picture editor is open, Escape belongs to it.
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !editing) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, editing]);

  if (!agent) return null;
  const dirty = name !== agent.name || personality !== agent.personality || specialty !== agent.specialty;
  const posted = snap.messages.filter((m) => m.authorId === agent.id).length;
  const cats = [...snap.categories].sort((a, b) => a.order - b.order);
  const partner = snap.agents.find((a) => a.id === agent.partnerId);

  return (
    <div className="overlay" onMouseDown={onClose} data-testid="agent-popup-overlay">
      <div className="agent-card" onMouseDown={(e) => e.stopPropagation()} data-testid="agent-popup">
        <div className="agent-banner" style={{ background: agent.color }} />
        <div className="agent-head">
          <Avatar agent={agent} size={84} status={agent.status}
            title="Change profile picture" onClick={() => setEditing(true)} />
          <div className="agent-id">
            <div className="agent-name">{agent.name}</div>
            <div className="muted">{agent.role}</div>
            <span className={`status-pill ${agent.status}`} data-testid="agent-status">{STATUS[agent.status]}</span>
          </div>
          <button className="icon-btn close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="agent-body">
          <div className="field-row">
            <label>Name (used for @mentions)
              <input value={name} onChange={(e) => setName(e.target.value)} data-testid="agent-name" />
            </label>
          </div>
          <ModelPicker key={agent.id} settings={snap.settings} value={{ tier: agent.tier, model: agent.model ?? null }}
            onChange={(v) => { if (!v.model || v.model.model) void act('updateAgent', agent.id, { tier: v.tier, model: v.model }); }} />

          <label>Specialty
            <textarea rows={2} value={specialty} onChange={(e) => setSpecialty(e.target.value)} />
          </label>
          <label>Personality
            <textarea rows={5} value={personality} onChange={(e) => setPersonality(e.target.value)} data-testid="agent-personality" />
          </label>

          <div className="field-row">
            <div className="stat"><span className="muted">Audit partner</span><strong>{partner ? partner.name : 'None (Widow reviews)'}</strong></div>
            <div className="stat"><span className="muted">Messages posted</span><strong>{posted}</strong></div>
          </div>

          <div className="section-label">Channels</div>
          <div className="chan-grid">
            {cats.map((c) => (
              <div key={c.id} className="chan-group">
                <div className="muted">{c.name}</div>
                {snap.channels.filter((ch) => ch.categoryId === c.id).sort((a, b) => a.order - b.order).map((ch) => (
                  <label key={ch.id} className="check">
                    <input type="checkbox" checked={ch.memberIds.includes(agent.id)}
                      disabled={agent.id === WIDOW_ID}
                      onChange={(e) => void act('setMember', ch.id, agent.id, e.target.checked)} />
                    # {ch.name}
                  </label>
                ))}
              </div>
            ))}
          </div>
          {agent.id === WIDOW_ID && <div className="muted small">Widow is a member of every channel and cannot be removed.</div>}
        </div>

        <div className="agent-foot">
          {agent.id !== WIDOW_ID ? (
            <button className="btn danger" onClick={async () => {
              if (window.confirm(`Remove ${agent.name} from the app? Their past messages stay in the channels.`)) {
                await act('removeAgent', agent.id);
                onClose();
              }
            }}>Remove agent</button>
          ) : <span />}
          <span className="foot-right">
            <button className="btn" data-testid="change-picture" onClick={() => setEditing(true)}>{agent.image ? 'Change picture' : 'Add picture'}</button>
            {agent.image && <button className="btn" onClick={() => void act('updateAgent', agent.id, { image: '' })}>Remove picture</button>}
            <button className="btn primary" disabled={!dirty} data-testid="agent-save"
              onClick={() => void act('updateAgent', agent.id, { name, personality, specialty })}>Save changes</button>
          </span>
        </div>
      </div>
      {editing && (
        <AvatarEditor onCancel={() => setEditing(false)}
          onSave={(img) => { setEditing(false); void act('updateAgent', agent.id, { image: img }); }} />
      )}
    </div>
  );
}
