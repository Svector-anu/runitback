/** Base class for rejections of an edit; the document and history are untouched when one is thrown. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A command argument is malformed (NaN, fractional ticks, negative time, unknown id, ...). */
export class InvalidInputError extends EngineError {}

/** The edit would leave the document in a state that breaks a structural invariant. */
export class InvariantViolationError extends EngineError {
  constructor(readonly violations: ReadonlyArray<string>, readonly commandLabel?: string) {
    const head = violations.slice(0, 3).join("; ");
    const more = violations.length > 3 ? ` (+${violations.length - 3} more)` : "";
    super(`${commandLabel ? `${commandLabel} rejected: ` : ""}${head}${more}`);
  }
}
