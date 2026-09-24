import { exports } from 'cloudflare:workers';

/** Calls the Worker's default export the way the edge would. */
export function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(new URL(path, 'https://portal.test'), init));
}
