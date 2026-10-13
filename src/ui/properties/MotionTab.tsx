import { useState, type ReactNode } from "react";
import type { ElementRef, TimelineElement } from "#/engine/model";
import { getMotionAnalysis } from "#/app/motion-analysis";
import { pointPickStore } from "#/app/point-pick";
import { zoomPickStore } from "#/app/zoom-pick";
import { Button } from "../primitives/Button";
import { Field, Section } from "../primitives/fields";
import { SliderField } from "../primitives/SliderField";
import { toast } from "../primitives/toast";
import "../styles/vfx.css";

function Progress({ value, onCancel }: { value: number; onCancel: () => void }): ReactNode {
  return (
    <div className="bg-removal" data-testid="motion-progress">
      <div className="row-between"><span>Analyzing… {Math.round(value * 100)}%</span><Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button></div>
      <progress className="bg-removal__bar" max={1} value={value} aria-label="Motion analysis progress" />
    </div>
  );
}

function StabilizeSection({ element }: { element: TimelineElement }): ReactNode {
  const motion = getMotionAnalysis();
  const job = motion.state.use((s) => s.jobs[element.id]);
  const [smoothness, setSmoothness] = useState(0.5);
  const run = (): void => {
    void motion.runTool({ name: "stabilize_clip", jobKey: element.id, args: { elementId: element.id, smoothness } }).then((result) => {
      if (result.ok) toast.success("Stabilised", result.summary);
      else if (!/abort/i.test(result.error)) toast.error("Could not stabilise", result.hint ? `${result.error} ${result.hint}` : result.error);
    });
  };
  return (
    <Section sectionKey={`${element.id}:stabilize`} title="Stabilize" collapsible>
      <div className="section__fields">
        <Field label="Smoothing">
          <SliderField label="Smoothing" value={smoothness} min={0.1} max={3} step={0.1} suffix="s" defaultValue={0.5} onPreview={setSmoothness} onCommit={setSmoothness} />
        </Field>
        {job?.kind === "stabilize" ? <Progress value={job.progress} onCancel={() => motion.cancel(element.id)} /> : <Button onClick={run} disabled={job !== undefined}>Stabilize clip</Button>}
        <p className="muted">Removes camera shake by counter-moving and slightly zooming the clip, measured on this device. Fixes shifts up and down and left and right only: no rotation, zoom wobble or rolling-shutter wobble. Use on one continuous shot; a longer smoothing also smooths real pans.</p>
      </div>
    </Section>
  );
}

function TrackSection({ element }: { element: TimelineElement }): ReactNode {
  const motion = getMotionAnalysis();
  const job = motion.state.use((s) => s.jobs[element.id]);
  const picking = pointPickStore.use((s) => s.targetElementId === element.id);
  return (
    <Section sectionKey={`${element.id}:track`} title="Follow a point" collapsible>
      <div className="section__fields">
        {job?.kind === "track" ? (
          <Progress value={job.progress} onCancel={() => motion.cancel(element.id)} />
        ) : (
          <Button variant={picking ? "secondary" : "default"} aria-pressed={picking} disabled={job !== undefined}
            onClick={() => pointPickStore.set({ targetElementId: picking ? null : element.id })}>
            {picking ? "Click a point on the video (Esc cancels)" : "Pick a point in the preview"}
          </Button>
        )}
        <p className="muted">Move the playhead to where the point is clearly visible, then click it on the video&apos;s picture. This clip then follows that point for as long as it overlaps the video. Pick a corner or detailed spot; flat areas and plain edges cannot be followed. Translation only: if the point turns, grows or is hidden it is marked lost and this clip holds still.</p>
      </div>
    </Section>
  );
}

function AutoZoomSection({ element }: { element: TimelineElement }): ReactNode {
  const picking = zoomPickStore.use((s) => s.targetElementId === element.id);
  const scale = zoomPickStore.use((s) => s.scale);
  const holdSeconds = zoomPickStore.use((s) => s.holdSeconds);
  return (
    <Section sectionKey={`${element.id}:auto-zoom`} title="Auto zoom" collapsible>
      <div className="section__fields">
        <Field label="Zoom amount">
          <SliderField label="Zoom amount" value={scale} min={1.2} max={6} step={0.1} suffix="x" defaultValue={2}
            onPreview={(v) => zoomPickStore.set({ scale: v })} onCommit={(v) => zoomPickStore.set({ scale: v })} />
        </Field>
        <Field label="Hold">
          <SliderField label="Hold" value={holdSeconds} min={0} max={6} step={0.1} suffix="s" defaultValue={1.5}
            onPreview={(v) => zoomPickStore.set({ holdSeconds: v })} onCommit={(v) => zoomPickStore.set({ holdSeconds: v })} />
        </Field>
        <Button variant={picking ? "secondary" : "default"} aria-pressed={picking}
          onClick={() => zoomPickStore.set({ targetElementId: picking ? null : element.id })}>
          {picking ? "Click the spot to zoom into (Esc cancels)" : "Zoom into a spot in the preview"}
        </Button>
        <p className="muted">Move the playhead to where the zoom should start, then click the spot on the picture. The clip eases in on it, holds, and eases back. It is written as keyframes on scale and position, replacing any already on them; edit them in the timeline like any other.</p>
      </div>
    </Section>
  );
}

/** Motion tools: stabilise a video clip, and make a text, graphic, image or video clip follow a point of another video. */
export function MotionTab({ element, refValue }: { element: TimelineElement; refValue: ElementRef }): ReactNode {
  void refValue;
  return (
    <>
      {element.type === "video" || element.type === "image" ? <AutoZoomSection element={element} /> : null}
      {element.type === "video" ? <StabilizeSection element={element} /> : null}
      <TrackSection element={element} />
    </>
  );
}
