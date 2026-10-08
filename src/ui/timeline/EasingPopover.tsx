import { useRef, useState, type ReactNode } from "react";
import { batch, currentScene, updateKeyframeCurveCommand, type Command } from "#/engine/commands";
import {
  EASING_PRESETS, curveToPatch, isScalarChannel, matchPreset, segmentToCurve, type NormalizedCurve,
} from "#/engine/animation";
import type { ScalarChannel, ScalarKey } from "#/engine/model";
import { getElement } from "#/engine/timeline";
import { getServices } from "#/app/services";
import { useEditorState } from "#/app/hooks";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";
import { Popover } from "../primitives/Popover";
import { Tooltip } from "../primitives/Tooltip";

interface Segment {
  channels: Array<{ component: "r" | "g" | "b" | "a" | "value"; left: ScalarKey; right: ScalarKey }>;
  ref: { trackId: string; elementId: string };
  path: string;
}

function selectedSegment(): Segment | null {
  const { editor } = getServices();
  const state = editor.getState();
  const kf = state.selection.keyframes;
  if (kf.length !== 1) return null;
  const sel = kf[0];
  if (!sel) return null;
  const el = getElement(currentScene(state.doc).tracks, { trackId: sel.trackId, elementId: sel.elementId });
  const binding = el?.animations?.[sel.propertyPath];
  if (!binding) return null;
  const channels: Array<[Segment["channels"][number]["component"], ScalarChannel]> =
    binding.kind === "color"
      ? [["r", binding.channels.r], ["g", binding.channels.g], ["b", binding.channels.b], ["a", binding.channels.a]]
      : isScalarChannel(binding.channel) ? [["value", binding.channel]] : [];
  const out: Segment["channels"] = [];
  for (const [component, channel] of channels) {
    const keys = [...channel.keys].sort((a, b) => a.time - b.time);
    const i = keys.findIndex((k) => k.id === sel.keyframeId);
    const left = keys[i];
    const right = keys[i + 1];
    if (left && right) out.push({ component, left, right });
  }
  return out.length ? { channels: out, ref: { trackId: sel.trackId, elementId: sel.elementId }, path: sel.propertyPath } : null;
}

export function EasingPopover({ disabled }: { disabled: boolean }): ReactNode {
  const { editor } = getServices();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  useEditorState((s) => s.selection.keyframes);
  const segment = open || !disabled ? selectedSegment() : null;
  const first = segment?.channels[0];
  const current = first ? segmentToCurve({ left: first.left, right: first.right }) : null;
  const active = current ? matchPreset(current)?.id : undefined;

  const apply = (curve: NormalizedCurve): void => {
    if (!segment) return;
    const commands: Command[] = [];
    for (const ch of segment.channels) {
      const patch = curveToPatch({ left: ch.left, right: ch.right, curve });
      if (!patch) continue;
      const base = { ref: segment.ref, path: segment.path, component: ch.component };
      commands.push(updateKeyframeCurveCommand({ ...base, keyframeId: ch.left.id, patch: { segmentToNext: patch.segmentToNext, rightHandle: patch.rightHandle } }));
      commands.push(updateKeyframeCurveCommand({ ...base, keyframeId: ch.right.id, patch: { leftHandle: patch.leftHandle } }));
    }
    if (commands.length) editor.execute(batch("Edit easing", commands));
  };

  const unavailable = !segment;
  return (
    <>
      <Tooltip content={unavailable ? "Select a keyframe that has a following keyframe to edit easing" : "Easing"} delay={400}>
        <span style={{ display: "inline-flex" }}>
          <Button ref={anchor} variant={open ? "secondary" : "ghost"} size="icon" label="Easing" className="btn--muted" disabled={disabled || unavailable} onClick={() => setOpen((o) => !o)}>
            <Icon name="gauge" />
          </Button>
        </span>
      </Tooltip>
      <Popover open={open && !unavailable} onClose={() => setOpen(false)} anchor={anchor} label="Easing presets" className="popover--padded">
        <div style={{ width: 240, padding: 12, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {EASING_PRESETS.map((preset) => (
            <button key={preset.id} type="button" className="btn btn--outline" aria-pressed={active === preset.id} title={preset.label}
              style={{ flexDirection: "column", height: "auto", padding: 6, gap: 4, ...(active === preset.id ? { borderColor: "var(--primary)" } : {}) }} onClick={() => apply(preset.curve)}>
              <svg width="40" height="22" viewBox="0 0 40 22" aria-hidden="true">
                <path d={`M2 20 C ${2 + preset.curve[0] * 36} ${20 - preset.curve[1] * 18}, ${2 + preset.curve[2] * 36} ${20 - preset.curve[3] * 18}, 38 2`} fill="none" stroke="var(--primary)" strokeWidth="2" />
              </svg>
              <span style={{ fontSize: 10 }}>{preset.label}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
