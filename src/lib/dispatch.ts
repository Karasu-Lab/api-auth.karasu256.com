export interface DispatchContext {
  env: Env;
  request: Request;
  pathname: string;
}

export interface Dispatchable {
  matches(): boolean;
  handle(): Promise<Response>;
}

export type DispatchableClass = new (context: DispatchContext) => Dispatchable;
