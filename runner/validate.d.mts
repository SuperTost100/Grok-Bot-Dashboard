// Types for validate.mjs, which stays plain JavaScript so the runner image needs nothing but Node.
export function checkCompose(compose: unknown, o: { id: string; network: string; env: Record<string, string>; others?: Record<string, string[]> }): {
  name: string;
  services: Record<string, Record<string, unknown>>;
  volumes: Record<string, object>;
  networks: Record<string, unknown>;
};
export function fillVars<T>(value: T, env: Record<string, string>): T;
