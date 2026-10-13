/** Copy and outbound links for the /templates gallery. See docs/TEMPLATES.md. */

export interface InspirationEntry {
  handle: string;
  /** Our own one-line description of the structure. No quoted copy, no thumbnails. */
  note: string;
  href: string;
}

export const GALLERY_COPY = {
  eyebrow: "Templates",
  title: "Start from a template",
  lead: "Original starting points for launch videos, lists, quotes and captions. Each one lays out a whole video from your clips: trims, text, animation and transitions. Pick one, fill in your media and words, then change anything on the timeline.",
  toolbarLabel: "Filter templates",
  searchLabel: "Search templates",
  searchPlaceholder: "Search templates",
  allLabel: "All",
  pauseLabel: "Pause previews",
  pausedByMotionNote: "Previews are off because your system prefers reduced motion.",
  useLabel: "Use template",
  emptyTitle: "No template matches",
  emptyBody: "Try another word or clear the filter.",
  clearFilter: "Clear filters",
} as const;

export const INSPIRATION = {
  title: "Inspiration",
  note: "Our templates are original; these are posts that inspired them.",
  collection: { label: "notes.apoorv.xyz/launch-videos", href: "https://notes.apoorv.xyz/launch-videos", curator: "@apoorveth" },
  /** Only posts whose public viewing was confirmed (docs/research/10-templates-research.md section 1.1). The other posts in the collection are not listed. */
  entries: [
    { handle: "@Lovable", note: "46 s, 16:9. Fast hook, then a product demo with quick cuts.", href: "https://x.com/Lovable/status/2056751240357580911" },
    { handle: "@Polymarket", note: "21 s, 16:9. A product spot led by the interface, with short phrases between scenes.", href: "https://x.com/Polymarket/status/2022343906168623112" },
  ] satisfies InspirationEntry[],
} as const;
