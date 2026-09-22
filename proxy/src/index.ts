/**
 * The worker entry. workerd accepts only handlers, functions and classes as
 * named exports of the entry module, so everything else (constants, types,
 * validators, the tests' imports) lives in worker.ts and this file exports
 * the handler alone.
 */
import { createHandler } from "./worker.ts";

export default { fetch: createHandler() };
