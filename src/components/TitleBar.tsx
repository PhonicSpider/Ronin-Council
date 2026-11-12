import logo from '../../assets/Logo/logo-title.png';
import { act, toast } from '../api';

/** The app's own title bar: logo and name on the left; Windows draws the window buttons on the right. */
export function TitleBar({ busy }: { busy: boolean }) {
  return (
    <header className="titlebar" data-testid="titlebar">
      <img className="titlebar-logo" src={logo} alt="" draggable={false} />
      <span className="titlebar-name">RONIN <b>COUNCIL</b></span>
      {busy && (
        <button className="stop-all" data-testid="stop-all" title="Stop every running agent and withdraw every pending request"
          onClick={async () => {
            const n = await act<number>('stopAll');
            if (n !== undefined) toast(n ? 'Stopped everything that was running.' : 'Nothing was running.');
          }}>
          <span className="stop-all-icon" aria-hidden="true" />Stop all
        </button>
      )}
    </header>
  );
}
