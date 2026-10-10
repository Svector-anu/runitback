import { useSyncExternalStore } from "react";

export type Route =
  | { name: "projects" }
  | { name: "editor"; id: string }
  | { name: "not-found" };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  if (path === "" || path === "/" || path === "/projects") return { name: "projects" };
  const editor = /^\/editor\/([^/]+)$/.exec(path);
  if (editor?.[1]) return { name: "editor", id: decodeURIComponent(editor[1]) };
  return { name: "not-found" };
}

export function navigate(path: string, options?: { replace?: boolean }): void {
  const target = `#${path}`;
  if (options?.replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (cb) => { window.addEventListener("hashchange", cb); window.addEventListener("popstate", cb); return () => { window.removeEventListener("hashchange", cb); window.removeEventListener("popstate", cb); }; },
    () => location.hash,
  );
  return parseRoute(hash);
}
