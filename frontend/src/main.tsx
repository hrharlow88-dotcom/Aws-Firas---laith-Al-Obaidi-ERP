import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import './styles.css';
import './responsive.css';
import { bootTheme } from './lib/theme';
import { watchResponsiveTables } from './lib/responsiveTables';

bootTheme();

// Installable app (Android, iPhone/iPad, Windows, macOS) through the service worker.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}

const root = document.getElementById('root')!;
// Tables become cards or scroll inside themselves on phones.
watchResponsiveTables(root);

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
