import type { MediaAnalysis } from "#/engine/analysis";

/**
 * Supplies already computed analyses. The app layer implements it on top of the browser analyzer (and its cache);
 * the engine never decodes media. `undefined` means "not analysed yet".
 */
export interface AnalysisProvider {
  get(assetId: string): MediaAnalysis | undefined | Promise<MediaAnalysis | undefined>;
}

export function createMapAnalysisProvider(analyses: Iterable<MediaAnalysis>): AnalysisProvider {
  const byId = new Map<string, MediaAnalysis>();
  for (const analysis of analyses) byId.set(analysis.assetId, analysis);
  return { get: (assetId) => byId.get(assetId) };
}

export const EMPTY_ANALYSIS_PROVIDER: AnalysisProvider = { get: () => undefined };
