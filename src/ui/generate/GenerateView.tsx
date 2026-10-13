import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useEditorState } from "#/app/hooks";
import { uiStore } from "#/app/ui-state";
import {
  GENERATE_KINDS, describeEstimate, formatUsd, priceHint, type GenerateKind, type GenerateModel,
} from "#/app/generate/catalog";
import { SURPLUS_SITE_URL, type GeneratePhase, type GenerateProgress, type SurplusKeyCheck } from "#/app/generate/client";
import { getGenerateService } from "#/app/generate/service";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";
import { Tabs } from "../primitives/fields";
import { toast } from "../primitives/toast";

const PRIVACY = "Your prompt leaves this device: it goes to Surplus Intelligence and on to the model provider it routes to. Your key stays in this browser. You pay Surplus directly; RunItBack adds no charge.";
const LIMITS = "Quality, speed and price depend on the model you pick. Results can be wrong, odd or unusable, and you are charged for what a model produces.";
const PHASE_LABEL: Readonly<Record<GeneratePhase, string>> = { submitting: "Sending the request", queued: "Waiting in the queue", running: "Generating", downloading: "Downloading the result" };
const PROMPT_LABEL: Readonly<Record<GenerateKind, string>> = { image: "Prompt", video: "Prompt", music: "Describe the music", speech: "Text to speak" };
const PROMPT_PLACEHOLDER: Readonly<Record<GenerateKind, string>> = {
  image: "A foggy harbor at sunrise, film photograph",
  video: "A slow dolly-in on waves rolling onto a beach",
  music: "Calm lo-fi beat with soft piano, instrumental",
  speech: "Welcome back to the channel.",
};

function ratioOf(size: string): string {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return "";
  let a = Number(match[1]);
  let b = Number(match[2]);
  const w = a;
  const h = b;
  while (b) [a, b] = [b, a % b];
  return `${w / a}:${h / a}`;
}

const sizeLabel = (size: string): string => (ratioOf(size) ? `${size} (${ratioOf(size)})` : size);

function describeProgress(progress: GenerateProgress): string {
  const seconds = Math.round(progress.elapsedMs / 1000);
  const percent = progress.fraction === undefined ? "" : `, ${Math.round(progress.fraction * 100)}%`;
  return `${PHASE_LABEL[progress.phase]}${progress.phase === "submitting" ? "..." : ` (${seconds} s${percent})`}`;
}

interface Options {
  size: string;
  aspectRatio: string;
  duration: string;
  voice: string;
}

function ModelSelect({ models, value, onChange, disabled }: { models: GenerateModel[]; value: string; onChange: (id: string) => void; disabled: boolean }): ReactNode {
  return (
    <select id="generate-model" className="select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {models.map((m) => <option key={m.id} value={m.id}>{m.name}{priceHint(m) ? ` - ${priceHint(m)}` : ""}</option>)}
    </select>
  );
}

function OptionSelect({ id, label, value, options, onChange, disabled }: {
  id: string; label: string; value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (v: string) => void; disabled: boolean;
}): ReactNode {
  return (
    <div className="generate-field">
      <label className="label" htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function KeySection(): ReactNode {
  const service = getGenerateService();
  const apiKey = service.state.use((s) => s.apiKey);
  const [check, setCheck] = useState<{ status: "idle" | "testing" } | { status: "done"; result: SurplusKeyCheck }>({ status: "idle" });
  const hasKey = apiKey !== "";
  const test = async (): Promise<void> => {
    setCheck({ status: "testing" });
    setCheck({ status: "done", result: await service.testKey() });
  };
  return (
    <div className="generate-section" data-testid="generate-key">
      <div className="generate-field">
        <label className="label" htmlFor="generate-key-input">Surplus API key</label>
        <input
          id="generate-key-input" className="input input--sm" type="password" autoComplete="off" spellCheck={false} placeholder="inf_..."
          value={apiKey} aria-describedby="generate-key-note" onChange={(e) => { service.setApiKey(e.target.value); setCheck({ status: "idle" }); }}
        />
      </div>
      <div className="generate-row">
        {hasKey ? (
          <>
            <Button size="sm" variant="outline" disabled={check.status === "testing"} onClick={() => void test()}>{check.status === "testing" ? "Testing..." : "Test key"}</Button>
            <Button size="sm" variant="ghost" onClick={() => { service.forgetKey(); setCheck({ status: "idle" }); }}>Forget key</Button>
          </>
        ) : <a className="btn btn--outline btn--sm" href={SURPLUS_SITE_URL} target="_blank" rel="noopener noreferrer">Get a key</a>}
      </div>
      <div className="generate-result-line" role="status" aria-live="polite" data-testid="generate-key-result">
        {check.status === "done" ? (
          <span className={check.result.ok ? "generate-ok" : "generate-error"}>{check.result.ok ? "Key works. Surplus accepted it." : check.result.message}</span>
        ) : null}
      </div>
      <p id="generate-key-note" className="generate-note">
        {hasKey ? "Saved in this browser only and sent only to api.surplusintelligence.ai. " : "Paste your Surplus key (it starts with inf_). It stays in this browser and is sent only to api.surplusintelligence.ai. "}
        Anyone using this browser profile can read it.
      </p>
    </div>
  );
}

function HostedCredits(): ReactNode {
  return (
    <div className="generate-section generate-hosted" data-testid="generate-hosted">
      <Button size="sm" variant="outline" disabled aria-describedby="generate-hosted-note">Generate with hosted credits</Button>
      <p id="generate-hosted-note" className="generate-note">
        Hosted credits, sponsored by us: coming soon. Want free generations? Bring your own Surplus key for now.
      </p>
    </div>
  );
}

export function GenerateView(): ReactNode {
  const service = getGenerateService();
  const state = service.state.use((s) => s);
  const hasProject = useEditorState((s) => s.meta?.id !== undefined);
  const [prompts, setPrompts] = useState<Partial<Record<GenerateKind, string>>>({});
  const [options, setOptions] = useState<Partial<Options>>({});
  const promptId = useId();
  const { apiKey, kind, catalog, job, result, error } = state;
  const hasKey = apiKey !== "";

  useEffect(() => {
    if (hasKey) void service.loadCatalog();
  }, [service, hasKey]);

  const models = useMemo(() => service.modelsFor(kind), [service, kind, catalog]);
  const model = useMemo(() => service.selectedModel(kind), [service, kind, catalog, state.chosen]);
  const prompt = prompts[kind] ?? "";
  const busy = job !== null;

  const pick = <T extends string>(valid: ReadonlyArray<T>, chosen: string | undefined, fallback: T): T => valid.find((v) => v === chosen) ?? fallback;
  const sizes = model?.sizes ?? [];
  const size = pick(sizes, options.size, (sizes.includes("1024x1024") ? "1024x1024" : sizes[0]) ?? "");
  const ratios = model?.aspectRatios ?? [];
  const aspectRatio = pick(ratios, options.aspectRatio, (ratios.includes("16:9") ? "16:9" : ratios[0]) ?? "");
  const durationChoices = ["", ...(model?.durations.map(String) ?? [])];
  const duration = pick(durationChoices, options.duration, "");
  const voices = model?.voices ?? [];
  const voice = pick(voices, options.voice, voices[0] ?? "");

  const request = model ? {
    kind, model, prompt: prompt.trim(),
    ...(kind === "image" && size ? { size } : {}),
    ...(kind === "video" && aspectRatio ? { aspectRatio } : {}),
    ...((kind === "video" || kind === "music") && duration ? { durationSeconds: Number(duration) } : {}),
    ...(kind === "speech" && voice ? { voice } : {}),
  } : null;
  const estimate = request ? service.estimate(request) : null;
  const canGenerate = hasKey && hasProject && request !== null && request.prompt !== "" && !busy;

  const generate = async (): Promise<void> => {
    if (!request) return;
    const outcome = await service.run(request);
    if (outcome.ok) toast.success(`${outcome.asset.name} added to Assets`);
  };
  const showInAssets = (assetId: string): void => uiStore.set({ assetTab: "media", revealMediaId: assetId, selectedAssetIds: [assetId] });
  const noun = GENERATE_KINDS.find((k) => k.id === kind)?.noun ?? "file";

  return (
    <div className="assets__view" data-testid="generate-panel">
      <div className="view__header">
        <span className="view__title">Generate</span>
      </div>
      <div className="view__body scrollbar-hidden generate">
        <KeySection />
        {hasKey ? (
          <div className="generate-section">
            <Tabs<GenerateKind> label="What to generate" value={kind} onChange={(k) => service.setKind(k)} tabs={GENERATE_KINDS.map((k) => ({ value: k.id, label: k.label }))} />
            <div className="generate-field">
              <label className="label" htmlFor="generate-model">Model</label>
              {catalog.status === "loading" && models.length === 0 ? <span className="generate-note" role="status">Loading models...</span> : null}
              {models.length > 0 && model ? <ModelSelect models={models} value={model.id} disabled={busy} onChange={(id) => service.setModel(kind, id)} /> : null}
              {catalog.status === "error" ? (
                <div className="generate-result-line">
                  <span className="generate-error" role="alert">{catalog.message}</span>
                  <Button size="sm" variant="outline" onClick={() => void service.loadCatalog({ force: true })}>Retry</Button>
                </div>
              ) : null}
              {catalog.status === "ready" && models.length === 0 ? <span className="generate-note">No {noun} models are listed right now.</span> : null}
            </div>

            <div className="generate-field">
              <label className="label" htmlFor={promptId}>{PROMPT_LABEL[kind]}</label>
              <textarea
                id={promptId} className="textarea" rows={4} value={prompt} disabled={busy} placeholder={PROMPT_PLACEHOLDER[kind]}
                onChange={(e) => setPrompts({ ...prompts, [kind]: e.target.value })}
              />
            </div>

            {kind === "image" && sizes.length > 0 ? (
              <OptionSelect id="generate-size" label="Size" value={size} disabled={busy} onChange={(v) => setOptions({ ...options, size: v })} options={sizes.map((s) => ({ value: s, label: sizeLabel(s) }))} />
            ) : null}
            {kind === "video" && ratios.length > 0 ? (
              <OptionSelect id="generate-aspect" label="Aspect ratio" value={aspectRatio} disabled={busy} onChange={(v) => setOptions({ ...options, aspectRatio: v })} options={ratios.map((r) => ({ value: r, label: r }))} />
            ) : null}
            {(kind === "video" || kind === "music") && model && model.durations.length > 0 ? (
              <OptionSelect
                id="generate-duration" label="Length" value={duration} disabled={busy} onChange={(v) => setOptions({ ...options, duration: v })}
                options={durationChoices.map((d) => ({ value: d, label: d === "" ? "Model default" : `${d} s` }))}
              />
            ) : null}
            {kind === "speech" && voices.length > 0 ? (
              <OptionSelect id="generate-voice" label="Voice" value={voice} disabled={busy} onChange={(v) => setOptions({ ...options, voice: v })} options={voices.map((v) => ({ value: v, label: v }))} />
            ) : null}

            {model ? <p className="generate-note" data-testid="generate-estimate">Estimated cost: {describeEstimate(estimate)}. {kind === "video" || kind === "music" ? "Surplus quotes the exact price when the job is submitted." : ""}</p> : null}

            {!hasProject ? <p className="generate-note" role="status">Open a project to generate; results are added to its media library.</p> : null}
            <div className="generate-row">
              <Button size="sm" disabled={!canGenerate} onClick={() => void generate()}><Icon name="star" size={14} />Generate</Button>
              {busy ? <Button size="sm" variant="destructive-outline" onClick={() => service.cancel()}>Cancel</Button> : null}
            </div>

            {job ? (
              <div className="generate-progress" role="status" aria-live="polite" data-testid="generate-progress">
                <div className="progress" aria-hidden><div style={{ width: `${Math.round((job.progress.fraction ?? (job.progress.phase === "downloading" ? 0.95 : 0.05)) * 100)}%` }} /></div>
                <span>{describeProgress(job.progress)}</span>
                {job.progress.quotedUsd !== undefined ? (
                  <span className="generate-note">Surplus quote {formatUsd(job.progress.quotedUsd)}{job.progress.ceilingUsd !== undefined ? `, at most ${formatUsd(job.progress.ceilingUsd)}` : ""}. You are charged what the job actually costs.</span>
                ) : null}
              </div>
            ) : null}
            {error ? <div className="generate-error" role="alert" data-testid="generate-error">{error}</div> : null}
            {result && !job ? (
              <div className="generate-result-line" role="status" data-testid="generate-result">
                <span className="generate-ok">Added {result.name} to Assets.</span>
                <Button size="sm" variant="outline" onClick={() => showInAssets(result.assetId)}>Show in Assets</Button>
              </div>
            ) : null}
          </div>
        ) : null}

        <p className="generate-note">{LIMITS}</p>
        <p className="generate-note" data-testid="generate-privacy">{PRIVACY}</p>
        <HostedCredits />
      </div>
    </div>
  );
}
