import './polyfills';
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Learn from './pages/Learn';

function Router() {
  const [currentPage, setCurrentPage] = useState<'app' | 'learn'>(() => {
    // Check hash on initial load
    return window.location.hash === '#/learn' ? 'learn' : 'app';
  });

  useEffect(() => {
    // Listen for hash changes
    const handleHashChange = () => {
      setCurrentPage(window.location.hash === '#/learn' ? 'learn' : 'app');
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const navigateTo = (page: 'app' | 'learn') => {
    window.location.hash = page === 'learn' ? '#/learn' : '#/';
    setCurrentPage(page);
  };

  if (currentPage === 'learn') {
    return <Learn onBack={() => navigateTo('app')} />;
  }

  return <App onNavigateToLearn={() => navigateTo('learn')} />;
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

try {
  const root = createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <Router />
    </React.StrictMode>
  );
} catch (e) {
  console.error("Failed to render app:", e);
  rootElement.innerHTML = `<div style="padding: 20px; color: red;">Failed to load application: ${e instanceof Error ? e.message : String(e)}</div>`;
}