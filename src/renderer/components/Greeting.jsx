// A greeting the server sent to this account (e.g. a birthday wish): a card with
// the pet in a party hat, shown once on this device. On the desktop the main
// process also shows it on the pet window and opens this window. In the web /
// iPhone app the card is enough: the corner pet would sit on top of it.

import { api } from '../api.js';
import { useBun, useLive } from '../store.jsx';
import { Modal } from './Popover.jsx';
import { PixelSprite } from '../sprite.jsx';

const CONFETTI = 18;

export default function Greeting() {
  const { user, t } = useBun();
  const list = useLive(() => api.listGreetings(), [], ['greetings']) || [];
  const greeting = list[0];
  if (!greeting) return null;
  const close = () => api.seeGreeting(greeting.id).catch(() => {});

  return (
    <Modal onClose={close} className="greeting">
      <div className="pet-confetti greeting__confetti" aria-hidden="true">
        {Array.from({ length: CONFETTI }, (_, i) => (
          <i key={i} style={{ '--x': `${((i * 53) % 280) - 140}px`, '--d': `${(i % 9) * 0.25}s` }} />
        ))}
      </div>
      <PixelSprite animal={user.animal} anim="alert" scale={4} hat className="greeting__pet" />
      <div className="greeting__kicker">{t('greet.birthday')}</div>
      <p className="greeting__text">{greeting.text}</p>
      <button className="btn btn--primary" onClick={close} autoFocus>
        {t('greet.thanks')}
      </button>
    </Modal>
  );
}
