/** Register an awaitable cleanup with the owning Cordis fiber. `dispose` is
 * not a lifecycle event in Cordis; the event fallback is only for small hosts
 * that explicitly implement that convention without the effects capability.
 */
export function registerCleanup(ctx, cleanup) {
  let pending
  const dispose = () => pending ||= Promise.resolve().then(cleanup)
  if (typeof ctx?.effect === 'function') return ctx.effect(() => dispose)
  return ctx?.on?.('dispose', dispose)
}
