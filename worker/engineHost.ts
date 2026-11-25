/**
 * The tenant's own Docker engine, when it has one.
 *
 * Code the worker did not write — the agent, and the repositories' checks —
 * runs in the sandbox. Setting a product up and starting it for a test link
 * both need containers, and the sandbox has no Docker of its own: the host's
 * must never be handed to tenant code. So a tenant may have a Docker engine
 * of its own, reachable only on the tenant's network, and its address is
 * given to what runs in the sandbox as DOCKER_HOST.
 *
 * The worker never talks to it. It only passes the address on.
 */

export interface EngineHost {
  /** For example tcp://mvpfy-engine-acme:2375, as Docker reads it. */
  dockerHost: string;
  /** The engine's host name, which is where a product it runs is reached. */
  hostname: string;
}

export function engineHostFrom(env: NodeJS.ProcessEnv): EngineHost | null {
  const raw = (env.MVPFY_ENGINE_HOST ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MVPFY_ENGINE_HOST is not an address: ${JSON.stringify(raw)}`);
  }
  // Plain tcp on purpose, like the sandbox: the engine is next door on a
  // network nothing else of anyone else's is attached to.
  if (url.protocol !== 'tcp:' || !url.hostname || !url.port) {
    throw new Error('MVPFY_ENGINE_HOST must be tcp://host:port');
  }
  return { dockerHost: `tcp://${url.hostname}:${url.port}`, hostname: url.hostname };
}

/** An environment for the sandbox, with the engine in it when there is one. */
export function withEngine(env: NodeJS.ProcessEnv, engine: EngineHost | null): NodeJS.ProcessEnv {
  return engine ? { ...env, DOCKER_HOST: engine.dockerHost } : env;
}
