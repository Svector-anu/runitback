import { parseTemplate, summarizeTemplate, type ProjectTemplate, type TemplateSummary } from "#/engine/templates";
import productLaunch from "./product-launch.json";
import kineticAnnouncement from "./kinetic-announcement.json";
import featureCallouts from "./feature-callouts.json";
import beforeAfter from "./before-after.json";
import listicle from "./listicle.json";
import testimonialQuote from "./testimonial-quote.json";
import talkingHeadCaptions from "./talking-head-captions.json";
import metricChangelog from "./metric-changelog.json";

/** Source files, in gallery order. Each one is validated the moment this module loads, so a malformed template fails the build and the tests. */
const SOURCES: ReadonlyArray<unknown> = [
  productLaunch, kineticAnnouncement, featureCallouts, beforeAfter, listicle, testimonialQuote, talkingHeadCaptions, metricChangelog,
];

const CATALOG: ReadonlyArray<ProjectTemplate> = SOURCES.map((source) => parseTemplate(source));

const BY_ID: ReadonlyMap<string, ProjectTemplate> = new Map(CATALOG.map((template) => [template.id, template]));
if (BY_ID.size !== CATALOG.length) throw new Error("Two shipped templates share an id");

/** Every shipped template, in gallery order. */
export function listTemplates(): ReadonlyArray<ProjectTemplate> {
  return CATALOG;
}

export function getTemplate(id: string): ProjectTemplate | undefined {
  return BY_ID.get(id);
}

export function listTemplateSummaries(): TemplateSummary[] {
  return CATALOG.map(summarizeTemplate);
}

/** URLs of a template's preview files under the app's public folder, or null when it has none. */
export function previewUrls(template: ProjectTemplate): { poster: string; video: string } | null {
  return template.preview ? { poster: `/templates/${template.preview.poster}`, video: `/templates/${template.preview.video}` } : null;
}
