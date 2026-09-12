// The Worker has no bindings. `cloudflare:test` types reference `Cloudflare.Env`,
// which `wrangler types` would normally generate; declare it empty here instead.
declare namespace Cloudflare {
  interface Env {}
}
