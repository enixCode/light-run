/*
 * Thin pass-through to light-runner's Docker network CRUD.
 *
 * light-run does not own any network lifecycle logic - it exposes these
 * primitives over HTTP so a remote light-process (which drives Docker only
 * through light-run, with no direct daemon access) can allocate per-run
 * subnets, then reference them by name in POST /run. light-run never creates
 * the named network implicitly on a run: callers create it here first.
 *
 * See README "Network CRUD".
 */
export {
  createNetwork,
  deleteNetwork,
  networkExists,
  cleanupOrphanNetworks,
} from 'light-runner';
export type { CreateNetworkOptions, CleanupNetworkOptions } from 'light-runner';
