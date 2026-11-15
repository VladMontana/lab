/**
 * Zero-dependency HTML5 History Router for LabNotes.
 * Supports clean URLs (/p/:id, /admin/login, /), query parameters,
 * hash links, browser navigation, and programmatic navigate().
 */

import { writable, type Readable } from 'svelte/store';

export type RouteName =
  | 'catalog'
  | 'reader'
  | 'login'
  | 'admin-dashboard'
  | 'admin-editor'
  | 'admin-editor-new'
  | 'not-found';

export interface RouteState {
  name: RouteName;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  hash: string;
}

export type NavigationGuard = (toUrl: string) => boolean;
let activeGuard: NavigationGuard | null = null;

function parseQuery(search: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!search) return params;
  const searchParams = new URLSearchParams(search);
  for (const [key, val] of searchParams.entries()) {
    params[key] = val;
  }
  return params;
}

export function matchRoute(pathname: string, search: string, hash: string): RouteState {
  const [pathOnly, inlineQuery] = pathname.split('?');
  const query = parseQuery(search || (inlineQuery ? `?${inlineQuery}` : ''));
  const cleanPath = pathOnly.replace(/\/+$/, '') || '/';

  // 1. Root / Catalog: /
  if (cleanPath === '/' || cleanPath === '') {
    return {
      name: 'catalog',
      path: cleanPath,
      params: {},
      query,
      hash,
    };
  }

  // 2. Reader: /p/:id
  const readerMatch = cleanPath.match(/^\/p\/([^/]+)$/);
  if (readerMatch) {
    return {
      name: 'reader',
      path: cleanPath,
      params: { id: decodeURIComponent(readerMatch[1]) },
      query,
      hash,
    };
  }

  // 3. Admin Login: /admin/login
  if (cleanPath === '/admin/login') {
    return {
      name: 'login',
      path: cleanPath,
      params: {},
      query,
      hash,
    };
  }

  // 4. Admin Dashboard: /admin, /admin/dashboard, /admin/pages, /admin/subjects
  if (
    cleanPath === '/admin' ||
    cleanPath === '/admin/dashboard' ||
    cleanPath === '/admin/pages' ||
    cleanPath === '/admin/subjects'
  ) {
    return {
      name: 'admin-dashboard',
      path: cleanPath,
      params: {},
      query,
      hash,
    };
  }

  // 5. Admin New Page: /admin/pages/new
  if (cleanPath === '/admin/pages/new') {
    return {
      name: 'admin-editor-new',
      path: cleanPath,
      params: {},
      query,
      hash,
    };
  }

  // 6. Admin Edit Page: /admin/pages/:id/edit
  const adminEditMatch = cleanPath.match(/^\/admin\/pages\/([^/]+)\/edit$/);
  if (adminEditMatch) {
    return {
      name: 'admin-editor',
      path: cleanPath,
      params: { id: decodeURIComponent(adminEditMatch[1]) },
      query,
      hash,
    };
  }

  // 7. Wildcard fallback: not-found
  return {
    name: 'not-found',
    path: cleanPath,
    params: {},
    query,
    hash,
  };
}

function createRouterStore() {
  const initial = typeof window !== 'undefined'
    ? matchRoute(window.location.pathname, window.location.search, window.location.hash)
    : { name: 'catalog' as RouteName, path: '/', params: {}, query: {}, hash: '' };

  const { subscribe, set } = writable<RouteState>(initial);

  function registerGuard(guard: NavigationGuard): () => void {
    activeGuard = guard;
    return () => {
      if (activeGuard === guard) {
        activeGuard = null;
      }
    };
  }

  function update() {
    if (typeof window === 'undefined') return;
    const current = matchRoute(window.location.pathname, window.location.search, window.location.hash);
    set(current);
  }

  function navigate(url: string, options: { replace?: boolean } = {}): boolean {
    if (typeof window === 'undefined') return false;

    // Handle hash-only navigation (TOC jump)
    if (url.startsWith('#')) {
      window.location.hash = url;
      update();
      return true;
    }

    if (activeGuard && !activeGuard(url)) {
      return false;
    }

    if (options.replace) {
      window.history.replaceState({}, '', url);
    } else {
      window.history.pushState({}, '', url);
    }
    update();
    return true;
  }

  function init() {
    if (typeof window === 'undefined') return () => {};

    let currentUrl = window.location.pathname + window.location.search + window.location.hash;

    const handlePopState = () => {
      const targetUrl = window.location.pathname + window.location.search + window.location.hash;
      if (activeGuard && !activeGuard(targetUrl)) {
        window.history.pushState(null, '', currentUrl);
        return;
      }
      currentUrl = targetUrl;
      update();
    };

    const handleClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }

      const target = e.target as HTMLElement | null;
      const anchor = target?.closest<HTMLAnchorElement>('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href) return;

      // Ignore external or non-http links
      if (
        anchor.target === '_blank' ||
        href.startsWith('http://') ||
        href.startsWith('https://') ||
        href.startsWith('mailto:') ||
        href.startsWith('tel:') ||
        href.startsWith('/media/') ||
        href.startsWith('/api/') ||
        anchor.hasAttribute('download')
      ) {
        return;
      }

      // Hash jump on current page
      if (href.startsWith('#')) {
        e.preventDefault();
        window.location.hash = href;
        const targetEl = document.querySelector(href);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth' });
        }
        update();
        return;
      }

      // Internal app navigation
      if (href.startsWith('/')) {
        e.preventDefault();
        navigate(href);
      }
    };

    window.addEventListener('popstate', handlePopState);
    document.addEventListener('click', handleClick);

    // Initial update
    update();

    return () => {
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('click', handleClick);
    };
  }

  return {
    subscribe,
    navigate,
    registerGuard,
    init,
  };
}

export const router = createRouterStore();
