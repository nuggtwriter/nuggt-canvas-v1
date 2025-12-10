import ResizeObserver from 'resize-observer-polyfill';

declare global {
  interface Window {
    ResizeObserver: typeof ResizeObserver;
  }
}

if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = ResizeObserver;
}

