export interface TranslateBackend {
  translate(input: { texts: string[] }): Promise<string[]>;
  dispose(): void;
}

export type TranslateRequest = { type: "translate"; id: number; model: string; texts: string[] };

export type TranslateResponse =
  | { type: "result"; id: number; texts: string[] }
  | { type: "error"; id: number; message: string };
