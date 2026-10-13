/**
 * Every word, link and image on the landing page lives in this file. Edit it to change copy; add or remove
 * entries in the arrays to add or remove nav links, feature cards, steps, FAQ items and footer links.
 * Section order and layout live in LandingPage.tsx. See docs/LANDING.md.
 *
 * Honesty rule: only describe what ships today. Anything unfinished is marked with `soonNote` and rendered
 * as "Coming soon". Do not add customer logos, ratings, testimonials or metrics unless they are real.
 */

const REPO = "https://github.com/Svector-anu/runitback";

export interface NavLink { label: string; target: SectionId }
export type SectionId = "product" | "templates" | "features" | "how-it-works" | "compare" | "open-source" | "faq";

export interface ShotImage {
  src: string;
  alt: string;
  width: number;
  height: number;
  /** CSS object-position used when the card crops the image. */
  position?: string;
  /** Width / height of the card that frames the image in the hero strip. */
  ratio?: number;
}

export type FeatureVisual = "prompt" | "moments" | "plan" | "private" | "timeline" | "templates" | "export";

export interface FeatureItem {
  id: string;
  title: string;
  body: string;
  visual: FeatureVisual;
  /** Width in a 12-column grid at desktop. */
  span: 4 | 5 | 7 | 12;
  /** Marks a part of the card as unfinished. Shown as a "Coming soon" pill. */
  soonNote?: string;
}

export interface StepItem { title: string; body: string }
export interface FaqItem { question: string; answer: string; link?: { label: string; href: string } }
export interface FooterColumn { title: string; links: Array<{ label: string; href: string; target?: SectionId; external?: boolean }> }
export interface CompareRow {
  feature: string;
  runitback: string;
  capcut: string;
  /** Which side is ahead on this row. Omit when neither is. Rendered as a small "ahead" tag. */
  ahead?: "runitback" | "capcut";
}
export interface OpenSourcePart { title: string; body: string }
export interface ExternalLink { label: string; href: string }

export interface LandingContent {
  brand: string;
  /**
   * GitHub links. The repository is private until the owner makes it public; the star link works from then on.
   * There is deliberately no live star count: the CSP blocks api.github.com. See docs/LANDING.md.
   */
  github: { repo: string; starLabel: string; readme: string; contributing: string; license: string; notice: string; issues: string };
  license: { name: string; badge: string; url: string };
  trademarkNote: string;
  nav: { links: NavLink[]; cta: string; menuLabel: string };
  hero: {
    status: string;
    /** First line of the h1, set smaller above the headline. */
    kicker: string;
    headline: string;
    sub: string;
    primaryCta: string;
    githubCta: string;
    templatesCta: string;
    trust: string[];
    strip: ShotImage[];
  };
  worksWith: { label: string; items: Array<{ title: string; detail: string }> };
  product: {
    eyebrow: string;
    title: string;
    intro: string;
    windowTitle: string;
    shotLight: ShotImage;
    shotDark: ShotImage;
    demo: { src: string; poster: string; label: string; caption: string };
  };
  templates: {
    eyebrow: string;
    title: string;
    intro: string;
    /** Template ids shown as preview cards, in order. */
    featured: string[];
    cta: string;
    note: string;
  };
  features: { eyebrow: string; title: string; intro: string; items: FeatureItem[] };
  how: { eyebrow: string; title: string; intro: string; steps: StepItem[] };
  plan: { eyebrow: string; title: string; points: string[]; image: ShotImage };
  compare: {
    eyebrow: string;
    title: string;
    intro: string;
    columns: { feature: string; runitback: string; capcut: string };
    rows: CompareRow[];
    aheadLabel: string;
    checked: string;
  };
  openSource: {
    eyebrow: string;
    title: string;
    intro: string;
    openLabel: string;
    parts: OpenSourcePart[];
    contribute: { title: string; body: string; links: ExternalLink[] };
  };
  faq: { eyebrow: string; title: string; items: FaqItem[]; aside: { title: string; body: string; cta: string } };
  finalCta: { status: string; title: string; body: string; primaryCta: string; githubCta: string; image: ShotImage };
  footer: { tagline: string; columns: FooterColumn[]; card: { title: string; body: string; cta: string }; note: string; legal: string };
}

export const LANDING_CONTENT: LandingContent = {
  brand: "RunItBack",
  github: {
    repo: REPO,
    starLabel: "Star on GitHub",
    readme: `${REPO}#readme`,
    contributing: `${REPO}/blob/main/CONTRIBUTING.md`,
    license: `${REPO}/blob/main/LICENSE`,
    notice: `${REPO}/blob/main/NOTICE.md`,
    issues: `${REPO}/issues`,
  },
  license: { name: "MIT", badge: "MIT licensed", url: `${REPO}/blob/main/LICENSE` },
  trademarkNote: "CapCut is a trademark of its respective owner. RunItBack is not affiliated with or endorsed by it.",
  nav: {
    links: [
      { label: "Templates", target: "templates" },
      { label: "Features", target: "features" },
      { label: "How it works", target: "how-it-works" },
      { label: "Compare", target: "compare" },
      { label: "Open source", target: "open-source" },
      { label: "FAQ", target: "faq" },
    ],
    cta: "Start editing",
    menuLabel: "Menu",
  },
  hero: {
    status: "Open source · MIT",
    kicker: "The open-source CapCut alternative",
    headline: "Tell your video editor what to do",
    sub: "RunItBack is a free video editor with an AI agent built in. Describe the edit in plain words, review the plan, and export, or start from one of eight original templates. It runs in your browser, and the code is yours to read and change.",
    primaryCta: "Start editing",
    githubCta: "Star on GitHub",
    templatesCta: "Start from a template",
    trust: ["Open source", "Private", "Works in Chrome"],
    strip: [
      { src: "/landing/card-timeline.webp", alt: "A close view of the timeline with three clips", width: 1200, height: 245, position: "0% 50%", ratio: 1.3 },
      { src: "/landing/card-preview.webp", alt: "The RunItBack preview window showing a sunset clip", width: 900, height: 687, position: "50% 100%", ratio: 1.5 },
      { src: "/landing/editor-light.webp", alt: "The RunItBack editor with three clips on the timeline", width: 1800, height: 1125, position: "50% 30%", ratio: 1.6 },
      { src: "/landing/card-plan.webp", alt: "The agent panel showing a plan waiting for approval", width: 800, height: 1107, position: "50% 12%", ratio: 0.8 },
      { src: "/landing/editor-dark.webp", alt: "The RunItBack editor in the dark theme", width: 1800, height: 1125, position: "60% 40%", ratio: 1.6 },
    ],
  },
  worksWith: {
    label: "Works with",
    items: [
      { title: "Chrome", detail: "Desktop browser" },
      { title: "Your local files", detail: "Stored in this browser" },
      { title: "Bring your own Anthropic API key", detail: "Claude models, billed by Anthropic" },
    ],
  },
  product: {
    eyebrow: "Product",
    title: "A real editor, with an agent beside it.",
    intro: "Media library, preview and timeline, with the inspector and the agent panel on the right. Whatever the agent does lands on the same timeline you edit by hand.",
    windowTitle: "RunItBack editor",
    shotLight: { src: "/landing/editor-light.webp", alt: "The RunItBack editor, light theme: media library, preview, agent panel and a three-clip timeline.", width: 1800, height: 1125 },
    shotDark: { src: "/landing/editor-dark.webp", alt: "The RunItBack editor, dark theme: media library, preview, agent panel and a three-clip timeline.", width: 1800, height: 1125 },
    demo: {
      src: "/landing/demo.mp4",
      poster: "/landing/demo-poster.jpg",
      label: "Demo",
      caption: "Import, understand, ask, review the plan, undo, export. A real recording of the editor and the agent, no sound.",
    },
  },
  templates: {
    eyebrow: "Templates",
    title: "Start from a template.",
    intro: "Eight original templates for launch videos, lists, quotes and captions. Pick one, drop in your clips and words, and edit the result like any other project.",
    featured: ["product-launch", "kinetic-announcement", "listicle", "testimonial-quote"],
    cta: "Browse all templates",
    note: "Applying a template is one undo step. Your media stays in your browser.",
  },
  features: {
    eyebrow: "Features",
    title: "Built to be told what to do.",
    intro: "An agent that reads your footage, shows its plan, and edits the same timeline you do.",
    items: [
      {
        id: "words",
        title: "Edit with words",
        body: "Say \"remove every silence longer than half a second\" or \"add a title card at the start\". The agent uses the same editing tools you have and checks its own work.",
        visual: "prompt",
        span: 7,
      },
      {
        id: "moments",
        title: "Find any moment",
        body: "Search what was said, what is on screen, or who is in frame. Transcript, visual and face search all run on your device after a one-time model download.",
        visual: "moments",
        span: 5,
      },
      {
        id: "plan",
        title: "Plan before it edits",
        body: "The agent shows a plan first. Nothing changes until you approve it, and one undo reverts the whole turn.",
        visual: "plan",
        span: 4,
      },
      {
        id: "private",
        title: "Private by design",
        body: "Your media stays in your browser, and there is no account.",
        visual: "private",
        span: 4,
      },
      {
        id: "timeline",
        title: "Real timeline",
        body: "Tracks, trimming, text, filters, transitions and keyframes, with snapping and full undo.",
        visual: "timeline",
        span: 4,
      },
      {
        id: "templates",
        title: "Start from a template",
        body: "Eight original templates lay out a whole video from your clips, with text, animation and transitions already set. One undo removes it.",
        visual: "templates",
        span: 5,
      },
      {
        id: "export",
        title: "Export MP4 or WebM",
        body: "Render in your browser with the same pipeline as the preview. Pick MP4 (H.264 and AAC) or WebM (VP9 and Opus).",
        visual: "export",
        span: 7,
      },
    ],
  },
  how: {
    eyebrow: "How it works",
    title: "From raw clips to export in five steps.",
    intro: "No account and nothing to install.",
    steps: [
      { title: "Import", body: "Drop in videos, photos and audio. They stay in your browser." },
      { title: "Understand", body: "It finds silences, speech, scenes and faces, on your device." },
      { title: "Tell it what to do", body: "Describe the edit in plain words, like \"cut the dead air\"." },
      { title: "Review the plan", body: "The agent shows what it will change. You approve it first." },
      { title: "Export", body: "Render an MP4 or WebM and keep it. One undo reverts any agent turn." },
    ],
  },
  plan: {
    eyebrow: "Control",
    title: "The agent proposes. You decide.",
    points: [
      "Each plan lists the steps, the clips they touch and how the agent will check the result.",
      "Approve, edit the plan with a follow-up, or reject it. Your timeline is untouched until you approve.",
      "One undo reverts everything the agent did in a turn.",
    ],
    image: { src: "/landing/card-plan.webp", alt: "The agent panel with a plan: three steps, each with tools, targets and a check, waiting for approval.", width: 800, height: 1107, position: "50% 0%" },
  },
  compare: {
    eyebrow: "Compare",
    title: "RunItBack vs CapCut",
    intro: "CapCut is a well-known editor with a lot behind it. Here is where RunItBack is different, and where it is not there yet.",
    columns: { feature: "", runitback: "RunItBack", capcut: "CapCut" },
    rows: [
      { feature: "Open source", runitback: "Yes, MIT licensed", capcut: "No", ahead: "runitback" },
      { feature: "Runs in your browser", runitback: "Yes, nothing to install", capcut: "Yes, with CapCut Online. It also has desktop apps." },
      { feature: "Files stay on your device while editing", runitback: "Yes, stored in your browser. The agent sends text and the frames it looks at to Anthropic, with your own key.", capcut: "Check CapCut's privacy policy." },
      { feature: "Edit by describing it", runitback: "Yes. An agent proposes a plan, you approve it, and one undo reverts it.", capcut: "AI tools that generate and edit. Check CapCut for how they work." },
      { feature: "Price", runitback: "Free. The agent uses your own Anthropic API key.", capcut: "A free plan, plus paid Pro, Ultra and Teams plans." },
      { feature: "Mobile app", runitback: "Not yet. Desktop Chrome for now.", capcut: "Yes, on mobile, tablet and desktop.", ahead: "capcut" },
      { feature: "Templates, stickers and effects", runitback: "Core effects, filters, transitions and 8 original templates are built in. Stickers and a large music and effects library: not yet.", capcut: "A large library of templates, stickers, effects and AI tools.", ahead: "capcut" },
    ],
    aheadLabel: "Ahead",
    checked: "CapCut details checked on capcut.com on 12 October 2026. Plans and features change, so check CapCut for the latest.",
  },
  openSource: {
    eyebrow: "Open source",
    title: "Built in the open.",
    intro: "RunItBack is released under the MIT license. Read it, run it, change it, and ship your own version.",
    openLabel: "What is open",
    parts: [
      { title: "The editor", body: "Timeline, preview and export, plus the editing engine underneath them." },
      { title: "The agent", body: "The tools it edits with, how plans are made and the prompts it runs on." },
    ],
    contribute: {
      title: "Want to help?",
      body: "Star the repository, pick an issue and open a pull request. Bug reports, small fixes, new evals and docs are all welcome.",
      links: [],
    },
  },
  faq: {
    eyebrow: "FAQ",
    title: "Questions, answered plainly.",
    items: [
      {
        question: "What is RunItBack?",
        answer: "An open-source video editor that runs in your browser. Edit by hand on a real timeline, or describe the edit and an AI agent shows a plan for you to approve. One undo reverses it. It is released under the MIT license and the code is on GitHub.",
      },
      {
        question: "What can it do today?",
        answer: "A multi-track timeline, keyframes, masks, text with stroke, shadow and animations, filters and colour adjustments, 7 transitions, crop, freeze frame, speed with pitch kept, captions from files or speech, 8 original templates, and export to MP4 or WebM. The agent can remove dead air, cut to the beat, find a spoken phrase or what is on screen, reframe to a face, and apply templates. In progress: beat-sync button, noise removal, text to speech, chroma key, speed ramps and background removal.",
      },
      {
        question: "Is my video uploaded?",
        answer: "Your files stay in your browser and are not uploaded. When you use the agent, the text it works from (timeline, transcripts, measurements) and any frames it chooses to look at are sent to the model provider you set up, such as Anthropic with your own key or a gateway you choose. Understand, transcription, search and face detection run on your device.",
      },
      {
        question: "What does it cost?",
        answer: "RunItBack is free. The agent uses your own Anthropic API key, so you pay Anthropic directly for what it uses. Editing and exporting without the agent needs no key. Hosted credits from us: coming soon.",
      },
      {
        question: "Can I use my Claude subscription?",
        answer: "Yes, through Claude Code. Claude Code is Anthropic's own app, and it can drive RunItBack through the MCP server in this repository, so your Pro or Max plan does the work. There is no \"sign in with Claude\" inside the web app, because Anthropic does not allow other apps to use subscription logins. For the built-in agent, use an Anthropic API key.",
      },
      {
        question: "Which browsers work?",
        answer: "Chrome on desktop is the supported browser. Firefox and Safari are not supported yet. On a phone the layout is limited, so it works best in desktop Chrome.",
      },
      {
        question: "What does Understand download?",
        answer: "Understand analyses silence, loudness, scenes and faces on your device. Transcription and visual search each need a small model from Hugging Face, about 50 MB for speech and about 156 MB for visual search. It asks once before downloading anything, you can decline, and the models are cached in your browser afterwards.",
      },
      {
        question: "Can the agent mess up my project?",
        answer: "It shows a plan first and edits only after you approve. One undo reverses the whole turn, and it cannot delete your media files. It can still make a wrong edit, so check the result. Undo is one click.",
      },
      {
        question: "Are templates free? Can I make my own?",
        answer: "All templates are original and free under the MIT license. They are JSON files in the repository. Importing or saving your own template in the app is coming soon; the format and a validator (parseTemplateJson) already exist.",
        link: { label: "Read docs/TEMPLATES.md", href: `${REPO}/blob/main/docs/TEMPLATES.md` },
      },
      {
        question: "Why not just use CapCut?",
        answer: "You may well like CapCut. It has mobile apps, accounts and cloud features, and far larger libraries of templates, stickers, music and effects. RunItBack is open source (MIT), runs in the browser, keeps your files on your device, and has an agent that plans before it edits. Its core effects, filters, transitions and 8 templates are built in, but its libraries are small.",
      },
      {
        question: "How do I contribute?",
        answer: "Star the repository on GitHub, read CONTRIBUTING, then open an issue or a pull request. Bug reports, small fixes, new evals and docs are all welcome.",
      },
    ],
    aside: {
      title: "Ready to try it?",
      body: "Open the editor and import a clip. No account needed.",
      cta: "Start editing",
    },
  },
  finalCta: {
    status: "Open source · MIT",
    title: "Your next edit starts with a sentence.",
    body: "Open the editor, drop in a clip and tell it what to do. Your media stays on your machine.",
    primaryCta: "Open the editor",
    githubCta: "Star on GitHub",
    image: { src: "/landing/editor-dark.webp", alt: "The RunItBack editor in the dark theme with a three-clip timeline.", width: 1800, height: 1125, position: "50% 30%" },
  },
  footer: {
    tagline: "The open-source video editor you can just talk to.",
    columns: [
      {
        title: "Product",
        links: [
          { label: "Templates", href: "#templates", target: "templates" },
          { label: "Features", href: "#features", target: "features" },
          { label: "How it works", href: "#how-it-works", target: "how-it-works" },
          { label: "Compare", href: "#compare", target: "compare" },
          { label: "FAQ", href: "#faq", target: "faq" },
        ],
      },
      {
        title: "Open source",
        links: [
          { label: "GitHub", href: REPO, external: true },
          { label: "README", href: `${REPO}#readme`, external: true },
          { label: "CONTRIBUTING", href: `${REPO}/blob/main/CONTRIBUTING.md`, external: true },
          { label: "LICENSE", href: `${REPO}/blob/main/LICENSE`, external: true },
        ],
      },
      {
        title: "App",
        links: [
          { label: "Start editing", href: "/app" },
          { label: "Your projects", href: "/#/projects" },
        ],
      },
    ],
    card: { title: "Got footage? Start cutting.", body: "Open the editor and import a clip. Nothing to install and no account.", cta: "Start editing" },
    note: "Open source under the MIT license.",
    legal: "RunItBack. Made for Chrome.",
  },
};
