import { createGenerateTools, type AgentTool, type GenerateDeps, type GenerateMediaKind } from "#/engine/agent";
import { TICKS_PER_SECOND } from "#/engine/time";
import { describeEstimate, formatUsd } from "../generate/catalog";
import { AGENT_MAX_ESTIMATED_USD, getGenerateService, type GenerateService } from "../generate/service";

export function generateDeps(service: GenerateService, signal: () => AbortSignal | undefined): GenerateDeps {
  const request = (input: { kind: GenerateMediaKind; prompt: string; model?: string }) => {
    const model = service.resolveModel(input.kind, input.model);
    return model ? service.withDefaults({ kind: input.kind, prompt: input.prompt, model }) : null;
  };
  return {
    prepare(input) {
      const { catalog } = service.state.get();
      if (catalog.status !== "ready") return { error: "The Surplus model list is not loaded.", hint: "Ask the user to open the Generate tab once, then retry." };
      const built = request(input);
      if (!built) {
        const known = service.modelsFor(input.kind).slice(0, 8).map((m) => m.id).join(", ");
        return { error: `No ${input.kind} model "${input.model ?? ""}" in the catalog.`, hint: known ? `Known ${input.kind} models: ${known}.` : `No ${input.kind} models are listed right now.` };
      }
      const estimate = service.estimate(built);
      const tooDear = estimate !== null && estimate.usd > AGENT_MAX_ESTIMATED_USD;
      return {
        modelId: built.model.id, modelName: built.model.name, costText: describeEstimate(estimate),
        ...(tooDear ? { refusal: `Estimated ${formatUsd(estimate.usd)} is above the ${formatUsd(AGENT_MAX_ESTIMATED_USD)} the agent may spend on one generation.` } : {}),
      };
    },
    async generate(input) {
      const built = request(input);
      if (!built) throw new Error("The model is no longer listed.");
      const outcome = await service.run(built, signal());
      if (!outcome.ok) throw new Error(outcome.error);
      const { asset, media } = outcome;
      const spent = media.chargedUsd ?? media.quotedUsd;
      return {
        assetId: asset.id, name: asset.name, type: asset.type,
        ...(asset.duration !== undefined ? { durationSeconds: asset.duration / TICKS_PER_SECOND } : {}),
        chargeText: spent === undefined ? "Charged by Surplus at its listed price." : `Charged about ${formatUsd(spent)} to the user's Surplus account.`,
      };
    },
  };
}

/** The generate tool, present only while a Surplus key is saved. Loads the public model catalog first so the tool can quote prices. */
export async function createAppGenerateTools(signal: () => AbortSignal | undefined): Promise<AgentTool[]> {
  const service = getGenerateService();
  if (!service.hasKey) return [];
  await service.loadCatalog();
  return createGenerateTools(generateDeps(service, signal));
}
