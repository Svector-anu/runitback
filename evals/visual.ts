import { createVisualTools, type AgentTool } from "#/engine/agent";
import { VISUAL_INDEX_VERSION, createMemoryVisualStore, normalize, planFrameTimes, type VisualEmbeddings, type VisualSearcher } from "#/engine/visual";
import type { ResolvedFixture } from "./types";

export const EVAL_VISUAL_MODEL = "eval/declared-concepts";

/**
 * Stand-in for the image model: every distinct `shows` word of the fixtures is one axis, a frame is the sum of the axes
 * of what the fixture declares on screen at that moment, and a query is the sum of the axes whose word it contains. Frames
 * are sampled with the real sampling plan, so moments get the same spans they would have with a real model.
 */
export function visualToolsFor(fixtures: ReadonlyArray<ResolvedFixture>): AgentTool[] {
  const withVisual = fixtures.filter((f) => f.spec.visual !== undefined);
  if (withVisual.length === 0) return [];
  const concepts = [...new Set(withVisual.flatMap((f) => (f.spec.visual ?? []).map((v) => v.shows)))].sort();
  const axis = (shows: string): Float32Array => Float32Array.from(concepts.map((c) => (c === shows ? 1 : 0)));
  const sum = (parts: ReadonlyArray<Float32Array>): Float32Array => normalize(Float32Array.from(concepts.map((_, i) => parts.reduce((total, p) => total + (p[i] ?? 0), 0))));

  const store = createMemoryVisualStore();
  for (const fixture of withVisual) store.save(embeddingsOf(fixture, concepts.length, (t) => sum((fixture.spec.visual ?? []).filter((v) => t >= v.start && t < v.end).map((v) => axis(v.shows)))));
  const searcher: VisualSearcher = {
    model: EVAL_VISUAL_MODEL,
    async embedText(query) {
      return sum(concepts.filter((c) => query.toLowerCase().includes(c.toLowerCase())).map(axis));
    },
  };
  return createVisualTools({ store, searcher });
}

function embeddingsOf(fixture: ResolvedFixture, dimensions: number, frameAt: (seconds: number) => Float32Array): VisualEmbeddings {
  const cuts = fixture.truth.shots.slice(1).map((s) => s.start);
  const times = planFrameTimes({ durationSeconds: fixture.spec.durationSeconds, cutTimes: cuts });
  const vectors = new Float32Array(times.length * dimensions);
  times.forEach((t, i) => vectors.set(frameAt(t), i * dimensions));
  return { version: VISUAL_INDEX_VERSION, assetId: fixture.assetId, model: EVAL_VISUAL_MODEL, dimensions, durationSeconds: fixture.spec.durationSeconds, cuts, times, vectors };
}
