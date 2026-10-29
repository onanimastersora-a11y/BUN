import { createRoot } from 'react-dom/client';
import { BunProvider } from './store.jsx';
import App from './App.jsx';
import './styles/base.css';
import './styles/app.css';

if (window.bun?.isElectron) {
  document.body.classList.add('is-electron');
  if (/Mac/.test(navigator.platform)) document.body.classList.add('is-mac');
} else if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // Web / iPhone build: cache the app so it opens offline, and receive push.
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
}

createRoot(document.getElementById('root')).render(
  <BunProvider>
    <App />
  </BunProvider>,
);
