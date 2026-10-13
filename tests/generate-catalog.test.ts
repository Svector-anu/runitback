import { describe, expect, it } from "vitest";
import { defaultModel, describeEstimate, estimateCost, modelsOfKind, parseCatalog, priceHint } from "#/app/generate/catalog";
import { CATALOG_BODY } from "./generate-fixtures";

describe("parseCatalog", () => {
  const models = parseCatalog(CATALOG_BODY);
  const ids = (kind: Parameters<typeof modelsOfKind>[1]): string[] => modelsOfKind(models, kind).map((m) => m.id);

  it("groups models by output modality and drops text models", () => {
    expect(models.some((m) => m.id === "chat-model")).toBe(false);
    expect(ids("image")).toEqual(["img-cheap", "img-dear", "img-tokens"]);
    expect(ids("video")).toEqual(["vid-t2v"]);
    expect(ids("music")).toEqual(["mus-a"]);
    expect(ids("speech")).toEqual(["tts-a"]);
  });

  it("excludes models that need a source file, legacy aliases and the music-route TTS", () => {
    expect(ids("image")).not.toContain("img-edit");
    expect(ids("image")).not.toContain("img-legacy");
    expect(ids("video")).not.toContain("vid-i2v");
    expect(ids("music")).not.toContain("mus-tts");
  });

  it("sorts cheapest first with unpriced models last, and defaults to the cheapest", () => {
    expect(defaultModel(models, "image")?.id).toBe("img-cheap");
    expect(modelsOfKind(models, "image").at(-1)?.price).toBeUndefined();
  });

  it("keeps the knobs a model advertises", () => {
    const image = models.find((m) => m.id === "img-cheap");
    expect(image).toMatchObject({ sizes: ["1024x768", "1024x1024"], aspectRatios: ["1:1", "16:9"] });
    expect(models.find((m) => m.id === "vid-t2v")?.durations).toEqual([4, 8]);
    expect(models.find((m) => m.id === "tts-a")?.voices).toEqual(["alloy", "echo"]);
  });

  it("tolerates garbage without throwing", () => {
    expect(parseCatalog(null)).toEqual([]);
    expect(parseCatalog({ data: [1, null, { id: 5 }, { id: "x" }] })).toEqual([]);
  });
});

describe("price hints and estimates", () => {
  const models = parseCatalog(CATALOG_BODY);
  const get = (id: string) => models.find((m) => m.id === id)!;

  it("states only what the catalog states", () => {
    expect(priceHint(get("img-cheap"))).toBe("$0.01 per image");
    expect(priceHint(get("vid-t2v"))).toBe("$0.32 per job");
    expect(priceHint(get("img-tokens"))).toBe("");
    expect(describeEstimate(estimateCost({ model: get("img-tokens") }))).toMatch(/not listed/);
  });

  it("estimates per unit and marks scaled prices approximate", () => {
    expect(estimateCost({ model: get("img-cheap") })).toEqual({ usd: 0.01, approximate: false });
    expect(estimateCost({ model: get("vid-t2v") })).toEqual({ usd: 0.32, approximate: true });
    expect(estimateCost({ model: get("tts-a"), characters: 2000 })?.usd).toBeCloseTo(0.007);
    expect(describeEstimate(estimateCost({ model: get("vid-t2v") }))).toBe("About $0.32");
  });
});

describe("landing FAQ", () => {
  it("tells the truth about generation: bring your own key, prompts leave the device, hosted credits are not live", async () => {
    const { LANDING_CONTENT } = await import("../src/ui/pages/landing-content");
    const answer = LANDING_CONTENT.faq.items.find((f) => /generate/i.test(f.question))?.answer ?? "";
    expect(answer).toMatch(/your own Surplus/);
    expect(answer).toMatch(/Your prompt goes to Surplus/);
    expect(answer).toContain("Hosted credits, sponsored by us: coming soon. Want free generations? Bring your own Surplus key for now.");
  });
});
