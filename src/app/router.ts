import { useSyncExternalStore } from "react";

export type Route =
  | { name: "projects" }
  | { name: "editor"; id: string; template?: string }
  | { name: "templates" }
  | { name: "not-found" };

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  if (path === "" || path === "/" || path === "/projects") return { name: "projects" };
  if (path === "/templates") return { name: "templates" };
  const editor = /^\/editor\/([^/]+)$/.exec(path);
  if (editor?.[1]) {
    const template = new URLSearchParams(query).get("template");
    return { name: "editor", id: decodeURIComponent(editor[1]), ...(template ? { template } : {}) };
  }
  return { name: "not-found" };
}

export function navigate(path: string, options?: { replace?: boolean }): void {
  const target = `#${path}`;
  if (options?.replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** Moves from a marketing page (a real pathname such as `/templates`) into the app shell without a reload. */
export function navigateToApp(path: string): void {
  history.pushState(null, "", `/app#${path}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (cb) => { window.addEventListener("hashchange", cb); window.addEventListener("popstate", cb); return () => { window.removeEventListener("hashchange", cb); window.removeEventListener("popstate", cb); }; },
    () => location.hash,
  );
  return parseRoute(hash);
}
