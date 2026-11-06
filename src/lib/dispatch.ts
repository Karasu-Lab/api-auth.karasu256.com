export interface DispatchContext {
  env: Env;
  request: Request;
  pathname: string;
  body: unknown;
}

export interface Dispatchable {
  matches(): boolean;
  handle(): Promise<Response>;
}

export type DispatchableClass = new (context: DispatchContext) => Dispatchable;
