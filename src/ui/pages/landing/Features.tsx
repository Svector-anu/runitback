import type { ReactNode } from "react";
import { LANDING_CONTENT, type FeatureItem, type FeatureVisual } from "../landing-content";
import { ArrowUpRight, Check, SectionHead, stagger } from "./parts";

const { features } = LANDING_CONTENT;

const PROMPT_EXAMPLES = ["Add a title card at the start", "Build a rough cut", "Check my edit"];
const MOMENT_ROWS = [
  { label: "Transcript", marks: [12, 41, 77] },
  { label: "Visual", marks: [24, 58] },
  { label: "Faces", marks: [8, 33, 64, 90] },
];
const PLAN_STEPS = ["Trim the tail of the first clip", "Add a short title", "Check the whole sequence"];
const TEMPLATE_CHIPS = ["Product launch", "Numbered list", "Testimonial", "Captions"];
const EFFECT_CHIPS = ["Chroma key", "Speed ramps", "Remove background", "Track a point", "Stabilize", "Snap to beat", "Noise removal"];
const GENERATE_CHIPS = ["Images", "Video", "Music", "Voice-overs"];
const PRIVACY_POINTS = ["Files stay in this browser", "Models run on your device", "API key kept locally"];

function Visual({ kind, soonNote }: { kind: FeatureVisual; soonNote?: string }): ReactNode {
  switch (kind) {
    case "prompt":
      return (
        <div className="lp-vis lp-vis--prompt" aria-hidden="true">
          <div className="lp-vis__prompt">
            <span>Remove every silence longer than half a second</span>
            <i className="zn-btn__circle"><ArrowUpRight size={13} /></i>
          </div>
          <ul className="lp-vis__chips">{PROMPT_EXAMPLES.map((text) => <li key={text}>{text}</li>)}</ul>
        </div>
      );
    case "moments":
      return (
        <div className="lp-vis lp-vis--moments" aria-hidden="true">
          {MOMENT_ROWS.map((row) => (
            <div key={row.label} className="lp-vis__lane">
              <span className="zn-mono">{row.label}</span>
              <div className="lp-vis__track">{row.marks.map((at) => <i key={at} style={{ left: `${at}%` }} />)}</div>
            </div>
          ))}
        </div>
      );
    case "plan":
      return (
        <div className="lp-vis lp-vis--plan" aria-hidden="true">
          <ol>{PLAN_STEPS.map((step, index) => <li key={step}><b>{index + 1}</b>{step}</li>)}</ol>
          <div className="lp-vis__actions"><span className="lp-vis__approve">Approve</span><span className="lp-vis__reject">Reject</span></div>
        </div>
      );
    case "private":
      return (
        <ul className="lp-vis lp-vis--private" aria-hidden="true">
          {PRIVACY_POINTS.map((point) => <li key={point}><Check />{point}</li>)}
        </ul>
      );
    case "timeline":
      return (
        <div className="lp-vis lp-vis--timeline" aria-hidden="true">
          <div className="lp-vis__bar"><span style={{ width: "46%" }}>Clip A</span><span style={{ width: "32%" }}>Clip B</span></div>
          <div className="lp-vis__bar lp-vis__bar--keys"><span style={{ width: "70%" }}><em style={{ left: "12%" }} /><em style={{ left: "44%" }} /><em style={{ left: "78%" }} /></span></div>
          {soonNote ? <p className="zn-tag lp-vis__soon">{soonNote}</p> : null}
        </div>
      );
    case "templates":
      return (
        <ul className="lp-vis lp-vis--templates" aria-hidden="true">
          {TEMPLATE_CHIPS.map((name) => <li key={name}>{name}</li>)}
        </ul>
      );
    case "effects":
      return (
        <ul className="lp-vis lp-vis--templates" aria-hidden="true">
          {EFFECT_CHIPS.map((name) => <li key={name}>{name}</li>)}
        </ul>
      );
    case "generate":
      return (
        <ul className="lp-vis lp-vis--templates" aria-hidden="true">
          {GENERATE_CHIPS.map((name) => <li key={name}>{name}</li>)}
        </ul>
      );
    case "export":
      return (
        <ul className="lp-vis lp-vis--export" aria-hidden="true">
          <li><b>MP4</b><span className="zn-mono">H.264 + AAC</span></li>
          <li><b>WebM</b><span className="zn-mono">VP9 + Opus</span></li>
        </ul>
      );
  }
}

function FeatureCard({ item, index }: { item: FeatureItem; index: number }): ReactNode {
  return (
    <article className={`lp-card zn-surface zn-reveal lp-span-${item.span}`} style={stagger(index % 3)} data-feature={item.id}>
      <div className="lp-card__text">
        <h3 className="zn-h3">{item.title}</h3>
        <p className="lp-card__body">{item.body}</p>
      </div>
      <Visual kind={item.visual} soonNote={item.soonNote} />
    </article>
  );
}

export function Features(): ReactNode {
  return (
    <section id="features" className="lp-section lp-wrap" aria-labelledby="features-title" tabIndex={-1}>
      <SectionHead index={4} eyebrow={features.eyebrow} title={features.title} intro={features.intro} titleId="features-title" />
      <div className="zn-frame lp-bento">
        {features.items.map((item, index) => <FeatureCard key={item.id} item={item} index={index} />)}
      </div>
    </section>
  );
}
