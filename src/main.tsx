import React from 'react';
import ReactDOM from 'react-dom/client';

// Island Ops is the game; the original operational sim stays reachable at #classic.
const root = ReactDOM.createRoot(document.getElementById('root')!);

// Fonts are self-hosted (latin subset) and loaded with each mode's chunk, so a
// blocked font CDN can never hold the page blank.
const classic = location.hash === '#classic' || new URLSearchParams(location.search).has('replay');

const boot = classic
  ? Promise.all([
      import('./App'),
      import('./styles.css'),
      import('@fontsource/rajdhani/latin-500.css'),
      import('@fontsource/rajdhani/latin-600.css'),
      import('@fontsource/rajdhani/latin-700.css'),
      import('@fontsource/inter/latin-400.css'),
      import('@fontsource/inter/latin-500.css'),
      import('@fontsource/inter/latin-600.css'),
    ]).then(([{ default: App }]) => (
      <React.StrictMode>
        <App />
      </React.StrictMode>
    ))
  : Promise.all([
      import('./island/IslandApp'),
      import('./island/island.css'),
      import('@fontsource/russo-one/latin-400.css'),
      import('@fontsource/nunito/latin-600.css'),
      import('@fontsource/nunito/latin-700.css'),
      import('@fontsource/nunito/latin-800.css'),
      import('@fontsource/nunito/latin-900.css'),
    ]).then(([{ default: IslandApp }]) => (
      <React.StrictMode>
        <IslandApp />
      </React.StrictMode>
    ));

boot.then(
  (app) => root.render(app),
  (err) => {
    // Usually a tab left open across a deploy, asking for a bundle that no longer exists.
    console.error(err);
    root.render(
      <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', color: '#fff', background: '#08192b', height: '100%' }}>
        <h1 style={{ marginTop: 0 }}>COMMAND couldn't load</h1>
        <p>The game was updated or the connection dropped while it was loading.</p>
        <button onClick={() => location.reload()} style={{ font: 'inherit', padding: '10px 18px', borderRadius: 10, border: 0, cursor: 'pointer' }}>
          Reload
        </button>
      </div>,
    );
  },
);

// Switching modes swaps whole stylesheets, so reload rather than hot-swap.
window.addEventListener('hashchange', () => location.reload());
