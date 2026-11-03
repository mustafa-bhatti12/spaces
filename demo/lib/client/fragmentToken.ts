let taken: { path: string; token: string } | null = null;

/**
 * The join token in the URL fragment (`#t=<token>`), removed from the address bar at once so it
 * never lands in history, a copied link or a log. Fragments are not sent to any server. Remembered
 * for the page, because React runs effects twice in development and the second read would find nothing.
 */
export function takeFragmentToken(): string {
  const path = window.location.pathname + window.location.search;
  if (taken?.path === path) return taken.token;
  const token = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? '';
  history.replaceState(null, '', path);
  taken = { path, token };
  return token;
}
