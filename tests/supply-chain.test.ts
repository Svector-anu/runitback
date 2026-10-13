import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CLIP_MODEL } from "#/platform/visual/indexer";
import { DEFAULT_WHISPER_MODEL } from "#/platform/transcribe/transcriber";
import { PINNED_MODEL_REVISIONS, revisionFor } from "#/platform/model-revisions";

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

interface HeaderRule { source: string; headers: { key: string; value: string }[] }
const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { headers: HeaderRule[] };

function policyFor(path: string): Map<string, string[]> {
  const rules = vercel.headers.filter((rule) => new RegExp(`^${rule.source}$`).test(path));
  const value = rules.flatMap((rule) => rule.headers).find((header) => header.key === "Content-Security-Policy")?.value ?? "";
  return new Map(value.split(";").map((part) => part.trim().split(/\s+/)).filter((tokens) => tokens[0]).map(([name, ...rest]) => [name as string, rest]));
}

describe("pinned model revisions", () => {
  it("pins the default Whisper and CLIP repos to full commit hashes", () => {
    for (const model of [DEFAULT_WHISPER_MODEL, DEFAULT_CLIP_MODEL]) expect(PINNED_MODEL_REVISIONS[model]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("unknown model ids track main", () => {
    expect(revisionFor("someone/else")).toBe("main");
  });
});

describe("self-hosted assets match the recorded hashes (docs/SUPPLY_CHAIN.md)", () => {
  const expected: Record<string, string> = {
    "public/mediapipe/blaze_face_short_range.tflite": "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f",
    "public/mediapipe/selfie_segmenter.tflite": "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b",
    "public/mediapipe/selfie_segmenter_landscape.tflite": "490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e",
    "public/mediapipe/wasm/vision_wasm_internal.js": "e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73",
    "public/mediapipe/wasm/vision_wasm_internal.wasm": "8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886",
    "public/fonts/inter-latin-wght-normal.woff2": "3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62",
  };
  for (const [path, hash] of Object.entries(expected)) {
    it(path, () => expect(sha256(path)).toBe(hash));
  }
});

describe("vercel.json content security policy", () => {
  const document = policyFor("/");

  it("allows only same-origin scripts and styles, plus wasm compilation", () => {
    expect(document.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(document.get("style-src")).toEqual(["'self'"]);
    expect(document.get("default-src")).toEqual(["'self'"]);
  });

  it("locks framing, plugins, base and forms", () => {
    expect(document.get("frame-ancestors")).toEqual(["'none'"]);
    expect(document.get("object-src")).toEqual(["'none'"]);
    expect(document.get("base-uri")).toEqual(["'self'"]);
    expect(document.get("form-action")).toEqual(["'self'"]);
  });

  it("limits connect-src to the hub, its CDN, the Anthropic API and the local agent bridge", () => {
    expect(document.get("connect-src")).toEqual(["'self'", "blob:", "https://huggingface.co", "https://*.hf.co", "https://api.anthropic.com", "ws://127.0.0.1:*", "ws://localhost:*"]);
  });

  it("grants unsafe-eval to exactly two scripts: the MediaPipe face and segmenter workers", () => {
    expect(policyFor("/assets/face-worker-AbC123.js").get("script-src")).toContain("'unsafe-eval'");
    expect(policyFor("/assets/face-worker-segmenter-AbC123.js").get("script-src")).toContain("'unsafe-eval'");
    for (const path of ["/", "/app", "/assets/whisper-worker-AbC123.js", "/assets/clip-worker-AbC123.js", "/assets/index-AbC123.js"]) {
      expect(policyFor(path).get("script-src"), path).not.toContain("'unsafe-eval'");
    }
  });

  it("never references Google Fonts", () => {
    expect(JSON.stringify(vercel)).not.toMatch(/googleapis|gstatic/);
    expect(readFileSync("index.html", "utf8")).not.toMatch(/googleapis|gstatic/);
  });
});
