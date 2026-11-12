import type { Agent, AgentStatus } from '../../shared/types';
import { initials } from '../util';

interface Props {
  agent?: Pick<Agent, 'name' | 'color' | 'image'> | null;
  size?: number;
  onClick?: () => void;
  title?: string;
  status?: AgentStatus;
}

export function Avatar({ agent, size = 36, onClick, title, status }: Props) {
  const style = {
    width: size, height: Math.round(size * 1.25), fontSize: size * 0.38,
    background: agent?.image ? 'transparent' : agent?.color ?? '#5a5f69',
  };
  return (
    <div
      className={`avatar${onClick ? ' clickable' : ''}`}
      style={style}
      onClick={onClick}
      title={title ?? agent?.name}
      data-testid="avatar"
    >
      {agent?.image ? <img src={agent.image} alt="" draggable={false} /> : initials(agent?.name ?? 'You')}
      {status && status !== 'idle' && <span className={`status-dot ${status}`} />}
    </div>
  );
}
