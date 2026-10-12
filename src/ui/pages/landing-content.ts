/**
 * Every word, link and image on the landing page lives in this file. Edit it to change copy; add or remove
 * entries in the arrays to add or remove nav links, feature cards, steps, FAQ items and footer links.
 * Section order and layout live in LandingPage.tsx. See docs/LANDING.md.
 *
 * Honesty rule: only describe what ships today. Anything unfinished is marked `soon: true` and rendered
 * as "Coming soon". Do not add customer logos, ratings, testimonials or metrics unless they are real.
 */

export interface NavLink { label: string; target: SectionId }
export type SectionId = "product" | "features" | "how-it-works" | "faq";

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

export type FeatureVisual = "prompt" | "moments" | "plan" | "private" | "timeline" | "export";

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
export interface FaqItem { question: string; answer: string }
export interface FooterColumn { title: string; links: Array<{ label: string; href: string; target?: SectionId }> }

export interface LandingContent {
  brand: string;
  nav: { links: NavLink[]; cta: string; menuLabel: string };
  hero: {
    status: string;
    headline: string;
    sub: string;
    primaryCta: string;
    secondaryCta: { label: string; target: SectionId };
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
  features: { eyebrow: string; title: string; intro: string; items: FeatureItem[] };
  how: { eyebrow: string; title: string; intro: string; steps: StepItem[] };
  plan: { eyebrow: string; title: string; points: string[]; image: ShotImage };
  faq: { eyebrow: string; title: string; items: FaqItem[]; aside: { title: string; body: string; cta: string } };
  finalCta: { status: string; title: string; body: string; primaryCta: string; secondaryCta: string; image: ShotImage };
  footer: { tagline: string; columns: FooterColumn[]; card: { title: string; body: string; cta: string }; note: string; legal: string };
}

export const LANDING_CONTENT: LandingContent = {
  brand: "RunItBack",
  nav: {
    links: [
      { label: "Features", target: "features" },
      { label: "How it works", target: "how-it-works" },
      { label: "FAQ", target: "faq" },
    ],
    cta: "Start editing",
    menuLabel: "Menu",
  },
  hero: {
    status: "Free in your browser · Chrome",
    headline: "Tell your video editor what to do",
    sub: "RunItBack is a video editor with an AI agent built in. Import your clips, describe the edit in plain words, review the plan, and export. Your media never leaves your browser.",
    primaryCta: "Start editing",
    secondaryCta: { label: "See how it works", target: "how-it-works" },
    trust: ["100% local", "No upload", "Works in Chrome"],
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
      poster: "/landing/editor-plan.webp",
      label: "Demo",
      caption: "A short walkthrough: import, ask, review, export.",
    },
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
        body: "Media stays in your browser. There is no account and no upload.",
        visual: "private",
        span: 4,
      },
      {
        id: "timeline",
        title: "Real timeline",
        body: "Tracks, trimming, text, effects and keyframes, with snapping and full undo.",
        visual: "timeline",
        span: 4,
        soonNote: "Transitions: coming soon",
      },
      {
        id: "export",
        title: "Export MP4 or WebM",
        body: "Render in your browser with the same pipeline as the preview. Pick MP4 (H.264 and AAC) or WebM (VP9 and Opus).",
        visual: "export",
        span: 12,
      },
    ],
  },
  how: {
    eyebrow: "How it works",
    title: "From raw clips to export in five steps.",
    intro: "No account, no upload queue, nothing to install.",
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
  faq: {
    eyebrow: "FAQ",
    title: "Questions, answered plainly.",
    items: [
      {
        question: "Is my video uploaded?",
        answer: "No. Your files are stored in your browser and never uploaded. When you use the agent, the text it works from (timeline, transcripts, measurements) and any frames it chooses to look at are sent to Anthropic with your own API key. Analysis, transcription, visual search and face detection run on your device.",
      },
      {
        question: "What does it cost?",
        answer: "RunItBack is free to use and adds no charge. The agent runs on your own Anthropic API key, so you pay Anthropic directly for what it uses. Editing and exporting without the agent needs no key.",
      },
      {
        question: "Which browsers does it work in?",
        answer: "Chrome on desktop. Other browsers are not supported yet.",
      },
      {
        question: "Which models can the agent use?",
        answer: "Claude Sonnet 5.5 (default), Opus 5.5 and Haiku 5.5, through your Anthropic API key. Your key is kept in this browser only.",
      },
      {
        question: "What does Understand download?",
        answer: "Understand analyses silence, loudness, scenes and faces on your device. Transcription and visual search each need a small model from Hugging Face, about 50 MB for speech and about 156 MB for visual search. It asks once before downloading anything, and nothing starts without your consent.",
      },
      {
        question: "Is it open source?",
        answer: "Not yet. The licence has not been decided, so today the code is not published. Source available soon.",
      },
    ],
    aside: {
      title: "Ready to try it?",
      body: "Open the editor and import a clip. No account, no upload.",
      cta: "Start editing",
    },
  },
  finalCta: {
    status: "Free in your browser · Chrome",
    title: "Your next edit starts with a sentence.",
    body: "Open the editor, drop in a clip and tell it what to do. Your media stays on your machine.",
    primaryCta: "Open the editor",
    secondaryCta: "Read the FAQ",
    image: { src: "/landing/editor-dark.webp", alt: "The RunItBack editor in the dark theme with a three-clip timeline.", width: 1800, height: 1125, position: "50% 30%" },
  },
  footer: {
    tagline: "Tell your video editor what to do.",
    columns: [
      {
        title: "Product",
        links: [
          { label: "Features", href: "#features", target: "features" },
          { label: "How it works", href: "#how-it-works", target: "how-it-works" },
          { label: "FAQ", href: "#faq", target: "faq" },
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
    card: { title: "Got footage? Start cutting.", body: "Open the editor and import a clip. Nothing to install, nothing to upload.", cta: "Start editing" },
    note: "Source available soon.",
    legal: "RunItBack. Made for Chrome.",
  },
};
