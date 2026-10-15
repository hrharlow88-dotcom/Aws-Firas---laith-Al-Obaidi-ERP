import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { bootTheme } from './lib/theme';

bootTheme();

// Installable app (Android, iPhone/iPad, Windows, macOS) through the service worker.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
