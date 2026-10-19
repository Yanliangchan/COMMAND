import React from 'react';
import ReactDOM from 'react-dom/client';

// Island Ops is the game; the original operational sim stays reachable at #classic.
const root = ReactDOM.createRoot(document.getElementById('root')!);

// Shared replay links (?replay=CODE) belong to the classic game too.
if (location.hash === '#classic' || new URLSearchParams(location.search).has('replay')) {
  Promise.all([import('./App'), import('./styles.css')]).then(([{ default: App }]) =>
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  );
} else {
  Promise.all([import('./island/IslandApp'), import('./island/island.css')]).then(([{ default: IslandApp }]) =>
    root.render(
      <React.StrictMode>
        <IslandApp />
      </React.StrictMode>,
    ),
  );
}

// Switching modes swaps whole stylesheets, so reload rather than hot-swap.
window.addEventListener('hashchange', () => location.reload());
