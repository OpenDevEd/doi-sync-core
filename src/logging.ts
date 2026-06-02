export type LogPrimitive = string | number | boolean | null;
export type LogValue = LogPrimitive | readonly LogValue[] | { readonly [key: string]: LogValue };
export type LogFields = { readonly [key: string]: LogValue };

export interface CoreLogger {
  readonly debug: (fields: LogFields, message: string) => void;
  readonly info: (fields: LogFields, message: string) => void;
  readonly warn: (fields: LogFields, message: string) => void;
  readonly error: (fields: LogFields, message: string) => void;
  readonly child: (fields: LogFields) => CoreLogger;
}

/** Creates a logger implementation that intentionally drops every log event. */
export function createNoopLogger(): CoreLogger {
  const noop = (): void => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => createNoopLogger()
  };
}
