export * from "./types";
export * from "./presets";
export { parseTemplate, parseTemplateJson, safeParseTemplate, type TemplateParseResult } from "./schema";
export {
  planTemplate, type CaptionCueInput, type PlannedClip, type PlannedGraphic, type PlannedKeyframe, type PlannedMedia, type PlannedText,
  type RepeatItemInput, type TemplateInputs, type TemplatePlan, type TemplateWarning, type TemplateWarningCode,
} from "./apply";
export {
  applyTemplateToEditor, TemplateApplyError, type ApplyTemplateOptions, type ApplyTemplateResult, type TemplateApplyErrorCode,
} from "./execute";
export { describeTemplate, summarizeTemplate, templateFontFamilies, type TemplateSummary, type TemplateDescription } from "./describe";
