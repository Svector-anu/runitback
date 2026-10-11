import { BUNDLED_FONTS, SYSTEM_FONTS } from "#/platform/fonts";

const GENERIC_FAMILIES: readonly string[] = ["monospace", "sans-serif", "serif"];

/** Families the picker offers: the ones that render identically everywhere (system faces and the bundled set). */
export const SYSTEM_FONTS_LIST: readonly string[] = [...SYSTEM_FONTS.filter((family) => !GENERIC_FAMILIES.includes(family)), ...BUNDLED_FONTS];
