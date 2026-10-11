import "fake-indexeddb/auto";
import { createHash, randomBytes } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { mediaTime } from "#/engine/time";
import { createProject, sequentialIds, type MediaAssetInfo, type Project, type VideoElement } from "#/engine/model";
import {
  BUNDLE_FORMAT, BundleError, MANIFEST_PATH, MemoryAssetRepository, MemoryProjectRepository, assetPath, findResidualIds, isAllowedEntryName,
  parseManifest, remapProjectIds, verifyArchiveAgainstManifest, type BundleManifest,
} from "#/engine/persistence";
import { allElements, assertDocumentInvariants } from "#/engine/timeline";
import { importProjectBundle, exportProjectBundle, bundleFileName } from "#/platform/bundle";
import { Sha256, crc32Update, digestBlob } from "#/platform/bundle-hash";
import { ZipArchive, ZipWriter } from "#/platform/bundle-zip";
import { IdbAnalysisStore, analysisCacheKey } from "#/platform/analysis";
import { DerivedDataRegistry } from "#/platform/derived-data";
import { analysisAdapter, faceAdapter, transcriptAdapter, visualAdapter } from "#/platform/derived-data-adapters";
import { IdbTranscriptStore } from "#/platform/transcribe";
import { IdbFaceStore, IdbVisualStore } from "#/platform/visual";
import { A1_FACE_FRAMES, detections } from "./face-harness";
import { sec, text, tracksWith, video, videoAsset } from "./helpers";
import { makeAnalysis } from "./temporal-harness";
import { TALK_WORDS, transcriptOf } from "./transcript-harness";
import { A1_FRAMES, makeEmbeddings } from "./visual-harness";

const hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("sha256 and crc32", () => {
  it("match node for assorted lengths and chunkings", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const data = new Uint8Array(randomBytes(n));
      const sha = new Sha256();
      for (let i = 0; i < n; i += 37) sha.update(data.subarray(i, i + 37));
      expect(sha.digestHex(), `length ${n}`).toBe(hex(data));
    }
    expect(crc32Update(0, new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("digests a blob in one streaming pass", async () => {
    const data = new Uint8Array(randomBytes(300_000));
    const d = await digestBlob(new Blob([data]));
    expect(d).toEqual({ size: data.length, sha256: hex(data), crc32: crc32Update(0, data) });
  });
});

const infoOf = (id: string, bytes: number): MediaAssetInfo => ({ ...videoAsset(id), size: bytes, lastModified: 1234 });

function sampleProject(): { project: Project; assets: MediaAssetInfo[] } {
  const ids = sequentialIds("src");
  const project = createProject({ id: "proj-old", name: "Round trip", ids, now: "2026-01-01T00:00:00.000Z" });
  const clip = video("el-clip", 0, 5);
  const keyed: VideoElement = {
    ...clip, mediaId: "asset-1",
    animations: { "transform.positionX": { kind: "channel", channel: { kind: "scalar", keys: [
      { id: "key-1", time: mediaTime(0), value: 0, segmentToNext: "linear", tangentMode: "auto" },
      { id: "key-2", time: sec(2), value: 100, segmentToNext: "linear", tangentMode: "auto" },
    ] } } },
  };
  const second = { ...video("el-clip2", 5, 3), mediaId: "asset-2" };
  const tracks = tracksWith({ main: [keyed, second], overlay: [{ id: "ov-1", type: "text", elements: [text("el-caption", 1, 2)] }] });
  const scene = { ...project.scenes[0]!, tracks };
  return { project: { ...project, scenes: [scene], assetIds: ["asset-1", "asset-2"] }, assets: [infoOf("asset-1", 2000), infoOf("asset-2", 3000)] };
}

describe("remapProjectIds", () => {
  it("replaces every id and reference consistently and keeps document invariants", () => {
    const { project, assets } = sampleProject();
    const before = JSON.stringify(project);
    const next = sequentialIds("new");
    const out = remapProjectIds({ project, assetIds: assets.map((a) => a.id), newId: next });
    expect(JSON.stringify(project)).toBe(before);
    const old = [...out.allIds.keys()];
    expect(old).toEqual(expect.arrayContaining(["proj-old", "el-clip", "key-1", "ov-1", "asset-1", "asset-2"]));
    expect(findResidualIds(out.project, old)).toEqual([]);
    assertDocumentInvariants(out.project);
    const media = allElements(out.project.scenes[0]!.tracks).flatMap((l) => ("mediaId" in l.element ? [l.element.mediaId] : []));
    expect(media.sort()).toEqual([out.assetIds.get("asset-1"), out.assetIds.get("asset-2")].sort());
    expect(out.project.assetIds).toEqual([out.assetIds.get("asset-1"), out.assetIds.get("asset-2")]);
    expect(out.project.currentSceneId).toBe(out.project.scenes[0]!.id);
    expect(new Set(out.allIds.values()).size).toBe(out.allIds.size);
  });

  it("rejects a reserved key", () => {
    const { project } = sampleProject();
    const hostile = JSON.parse('{"id":"x","__proto__":{"a":1}}') as unknown as Project;
    expect(() => remapProjectIds({ project: { ...project, ...hostile }, assetIds: [], newId: sequentialIds("n") })).toThrow(BundleError);
  });
});

describe("entry names and manifest validation", () => {
  it("allows only the canonical entries", () => {
    for (const ok of ["manifest.json", "project.json", "media/abc-1", "derived/transcript/abc.json"]) expect(isAllowedEntryName(ok), ok).toBe(true);
    for (const bad of ["../x", "/abs", "media/../x", "media/a/b", "media\\a", "derived/evil/a.json", "derived/faces/../a.json", "other.txt", "media/", "media/a b", "media/a\0"]) {
      expect(isAllowedEntryName(bad), bad).toBe(false);
    }
  });

  const good = (): BundleManifest => ({
    format: BUNDLE_FORMAT, bundleVersion: 1, app: "runitback", createdAt: "t", createdWith: "w", schemaVersion: 1,
    project: { path: "project.json", size: 10, sha256: "a".repeat(64), name: "n" },
    assets: [{ path: assetPath("a1"), size: 5, sha256: "b".repeat(64), info: infoOf("a1", 5) }], derived: [],
  });
  const code = (raw: unknown): string | undefined => { try { parseManifest(raw); return undefined; } catch (e) { return (e as BundleError).code; } };

  it("accepts a good manifest and rejects hostile ones with typed codes", () => {
    expect(code(good())).toBeUndefined();
    expect(code({ ...good(), format: "zip" })).toBe("not-a-bundle");
    expect(code({ ...good(), bundleVersion: 2 })).toBe("newer-version");
    expect(code({ ...good(), schemaVersion: 999 })).toBe("newer-version");
    expect(code({ ...good(), project: { ...good().project, path: "../etc/passwd" } })).toBe("unsafe-path");
    expect(code({ ...good(), assets: [{ ...good().assets[0], path: "media/other" }] })).toBe("unsafe-path");
    expect(code({ ...good(), assets: [{ ...good().assets[0], size: 2 ** 40 }] })).toBe("too-large");
    expect(code({ ...good(), assets: [{ ...good().assets[0], size: -1 }] })).toBe("malformed");
    expect(code({ ...good(), assets: [{ ...good().assets[0], sha256: "XYZ" }] })).toBe("malformed");
    expect(code({ ...good(), assets: [{ ...good().assets[0], info: { ...good().assets[0]!.info, id: "../x" } }] })).toBe("malformed");
    expect(code({ ...good(), assets: [good().assets[0], good().assets[0]] })).toBe("malformed");
    expect(code({ ...good(), derived: [{ path: "derived/faces/zz.json", kind: "faces", assetId: "zz", size: 1, sha256: "c".repeat(64) }] })).toBe("malformed");
    expect(code(null)).toBe("malformed");
  });
});

interface World {
  projects: MemoryProjectRepository; assets: MemoryAssetRepository; derived: DerivedDataRegistry;
  stores: { analysis: IdbAnalysisStore; transcripts: IdbTranscriptStore; visual: IdbVisualStore; faces: IdbFaceStore };
}
function world(): World {
  const f = new IDBFactory();
  const stores = { analysis: new IdbAnalysisStore(f), transcripts: new IdbTranscriptStore(f), visual: new IdbVisualStore(f), faces: new IdbFaceStore(f) };
  const derived = new DerivedDataRegistry().register(analysisAdapter(stores.analysis)).register(transcriptAdapter(stores.transcripts))
    .register(visualAdapter(stores.visual)).register(faceAdapter(stores.faces));
  return { projects: new MemoryProjectRepository(), assets: new MemoryAssetRepository(), derived, stores };
}

const bytesOf = new Map<string, Uint8Array>();

async function seedWorld(w: World): Promise<Project> {
  const { project, assets } = sampleProject();
  await w.projects.save(project);
  for (const info of assets) {
    const data = new Uint8Array(randomBytes(info.size));
    bytesOf.set(info.id, data);
    await w.assets.save(project.metadata.id, { info, file: new Blob([data]) });
  }
  const a1 = assets[0]!;
  await w.stores.analysis.put(analysisCacheKey(a1), makeAnalysis({ assetId: a1.id }));
  await w.stores.transcripts.save(transcriptOf(a1.id, TALK_WORDS));
  await w.stores.visual.save(makeEmbeddings({ assetId: a1.id, frames: A1_FRAMES }));
  await w.stores.faces.save(detections({ assetId: a1.id, frames: A1_FACE_FRAMES }));
  return project;
}

const exportDeps = (w: World) => ({ projects: w.projects, assets: w.assets, derived: w.derived, now: () => "2026-02-02T00:00:00.000Z", createdWith: "test" });
const importDeps = (w: World) => ({ projects: w.projects, assets: w.assets, derived: w.derived, newId: sequentialIds("imp"), now: () => "2026-03-03T00:00:00.000Z" });

describe("bundle round trip", () => {
  it("exports and imports as a new project with remapped ids, intact bytes and derived data", async () => {
    const w = world();
    const original = await seedWorld(w);
    const exported = await exportProjectBundle(exportDeps(w), { projectId: original.metadata.id, includeEmbeddings: false });
    expect(exported.fileName).toBe("Round-trip.runitback");
    expect(exported.manifest.derived.map((d) => d.kind).sort()).toEqual(["analysis", "faces", "transcript", "visual"]);

    const result = await importProjectBundle(importDeps(w), exported.blob);
    expect(result.derivedImported).toBe(4);
    expect(result.projectId).not.toBe(original.metadata.id);
    const imported = (await w.projects.load(result.projectId))!;
    expect(imported.metadata.name).toBe("(1) Round trip");
    assertDocumentInvariants(imported);
    const stored = await w.assets.list(result.projectId);
    expect(stored.map((s) => s.id).sort()).toEqual([...imported.assetIds].sort());
    expect(stored.some((s) => ["asset-1", "asset-2"].includes(s.id))).toBe(false);
    for (const info of stored) {
      const oldId = info.name === "asset-1.mp4" ? "asset-1" : "asset-2";
      const blob = (await w.assets.getFile(result.projectId, info.id))!;
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytesOf.get(oldId));
    }
    const a1 = stored.find((s) => s.name === "asset-1.mp4")!;
    expect((await w.stores.transcripts.get(a1.id))?.words).toHaveLength(TALK_WORDS.length);
    expect(await w.stores.faces.get(a1.id)).toBeDefined();
    expect(await w.stores.visual.get(a1.id)).toBeDefined();
    expect(await w.stores.analysis.get(analysisCacheKey(a1))).toBeDefined();
    expect((await w.projects.load(original.metadata.id))!.assetIds).toEqual(["asset-1", "asset-2"]);
  });

  it("round-trips through a File and survives importing the same bundle twice", async () => {
    const w = world();
    const original = await seedWorld(w);
    const { blob } = await exportProjectBundle(exportDeps(w), { projectId: original.metadata.id, includeEmbeddings: true });
    const file = new File([blob], "x.runitback");
    const deps = importDeps(w);
    const a = await importProjectBundle(deps, file);
    const b = await importProjectBundle(deps, file);
    expect(new Set([original.metadata.id, a.projectId, b.projectId]).size).toBe(3);
  });

  it("leaves no trace when an import fails midway", async () => {
    const w = world();
    const original = await seedWorld(w);
    const { blob } = await exportProjectBundle(exportDeps(w), { projectId: original.metadata.id, includeEmbeddings: false });
    const failing = { ...w.derived.store("faces")!, importAsset: async (): Promise<boolean> => { throw new Error("boom"); } };
    const registry = new DerivedDataRegistry().register(w.derived.store("transcript")!).register(failing);
    const before = (await w.projects.list()).length;
    await expect(importProjectBundle({ ...importDeps(w), derived: registry }, blob)).rejects.toThrow("boom");
    expect((await w.projects.list()).length).toBe(before);
    expect((await w.assets.listAllIds()).sort()).toEqual(["asset-1", "asset-2"]);
  });

  it("builds file names that are safe", () => {
    expect(bundleFileName("../a/b:c*?")).toBe("abc.runitback");
    expect(bundleFileName("   ")).toBe("project.runitback");
  });
});

describe("hostile and damaged bundles", () => {
  async function goodBundle(): Promise<{ w: World; blob: Blob }> {
    const w = world();
    const p = await seedWorld(w);
    return { w, blob: (await exportProjectBundle(exportDeps(w), { projectId: p.metadata.id, includeEmbeddings: false })).blob };
  }
  const codeOf = async (w: World, blob: Blob): Promise<string> => {
    try { await importProjectBundle(importDeps(w), blob); return "ok"; } catch (e) { return e instanceof BundleError ? e.code : `other:${(e as Error).message}`; }
  };
  const flip = async (blob: Blob, at: number): Promise<Blob> => {
    const data = new Uint8Array(await blob.arrayBuffer());
    data[at] = (data[at] as number) ^ 0xff;
    return new Blob([data]);
  };

  it("rejects non-bundles, empty and truncated files", async () => {
    const { w, blob } = await goodBundle();
    expect(await codeOf(w, new Blob([]))).toBe("not-a-bundle");
    expect(await codeOf(w, new Blob(["hello world, this is not a zip file at all"]))).toBe("truncated");
    expect(await codeOf(w, blob.slice(0, blob.size - 40))).toBe("truncated");
    expect(await codeOf(w, blob.slice(0, Math.floor(blob.size / 2)))).toBe("truncated");
  });

  it("detects flipped media bytes by checksum", async () => {
    const { w, blob } = await goodBundle();
    const zip = await ZipArchive.open(blob);
    const entry = zip.entries.get(assetPath("asset-1"))!;
    const marker = new Uint8Array(await (await zip.blob(assetPath("asset-1"))).arrayBuffer());
    expect(marker.length).toBe(2000);
    const start = entry.localOffset + 30 + assetPath("asset-1").length;
    expect(await codeOf(w, await flip(blob, start + 10))).toBe("checksum-mismatch");
  });

  it("rejects path traversal names, zip64 sentinels and unlisted entries", async () => {
    const w = world();
    const evil = new ZipWriter();
    expect(() => evil.addStored({ name: "../../evil", blob: new Blob(["x"]), crc32: 0 })).toThrow(BundleError);

    const { blob } = await goodBundle();
    const extra = new ZipWriter();
    await extra.addBytes(MANIFEST_PATH, new TextEncoder().encode("{}"));
    expect(await codeOf(w, extra.finish())).toBe("not-a-bundle");
    const manifest = parseManifest({ format: BUNDLE_FORMAT, bundleVersion: 1, app: "runitback", createdAt: "t", createdWith: "w", schemaVersion: 1,
      project: { path: "project.json", size: 1, sha256: "a".repeat(64), name: "n" }, assets: [], derived: [] });
    const entries = new Map([[MANIFEST_PATH, { size: 1 }], ["project.json", { size: 1 }]]);
    expect(() => verifyArchiveAgainstManifest(manifest, entries)).not.toThrow();
    expect(() => verifyArchiveAgainstManifest(manifest, new Map([...entries, ["media/zz", { size: 1 }]]))).toThrow(/does not list/);
    expect(() => verifyArchiveAgainstManifest(manifest, new Map([[MANIFEST_PATH, { size: 1 }]]))).toThrow(/missing/);
    expect(() => verifyArchiveAgainstManifest(manifest, new Map([...entries, ["project.json", { size: 2 }]]))).toThrow(/manifest says/);

    const raw = new Uint8Array(await blob.arrayBuffer());
    const patched = raw.slice();
    const eocd = patched.length - 22;
    new DataView(patched.buffer).setUint32(eocd + 16, 0xffffffff, true);
    expect(await codeOf(w, new Blob([patched]))).toBe("unsupported");
  });

  it("rejects a manifest from a newer app and a declared size over the limit", async () => {
    const w = world();
    for (const [patch, expected] of [[{ schemaVersion: 99 }, "newer-version"], [{ bundleVersion: 9 }, "newer-version"]] as const) {
      const zip = new ZipWriter();
      const base: Record<string, unknown> = {
        format: BUNDLE_FORMAT, bundleVersion: 1, app: "runitback", createdAt: "t", createdWith: "w", schemaVersion: 1,
        project: { path: "project.json", size: 1, sha256: "a".repeat(64), name: "n" }, assets: [], derived: [],
      };
      await zip.addBytes(MANIFEST_PATH, new TextEncoder().encode(JSON.stringify({ ...base, ...patch })));
      expect(await codeOf(w, zip.finish())).toBe(expected);
    }
    const huge = new ZipWriter();
    await huge.addBytes(MANIFEST_PATH, new TextEncoder().encode(JSON.stringify({
      format: BUNDLE_FORMAT, bundleVersion: 1, app: "runitback", createdAt: "t", createdWith: "w", schemaVersion: 1,
      project: { path: "project.json", size: 1, sha256: "a".repeat(64), name: "n" },
      assets: [{ path: assetPath("a1"), size: 2 ** 33, sha256: "b".repeat(64), info: infoOf("a1", 1) }], derived: [],
    })));
    expect(await codeOf(w, huge.finish())).toBe("too-large");
  });

  it("refuses a deflate entry that expands past its declared size", async () => {
    const zip = new ZipWriter();
    await zip.addBytes(MANIFEST_PATH, new TextEncoder().encode(JSON.stringify({ pad: "a".repeat(5000) })));
    const blob = zip.finish();
    const data = new Uint8Array(await blob.arrayBuffer());
    const archive = await ZipArchive.open(blob);
    const entry = archive.entries.get(MANIFEST_PATH)!;
    expect(entry.method).toBe(8);
    const view = new DataView(data.buffer);
    view.setUint32(entry.localOffset + 22, 100, true);
    const centralStart = view.getUint32(data.length - 22 + 16, true);
    view.setUint32(centralStart + 24, 100, true);
    await expect(ZipArchive.open(new Blob([data])).then((a) => a.bytes(MANIFEST_PATH, 1000))).rejects.toMatchObject({ code: "malformed" });
  });
});
