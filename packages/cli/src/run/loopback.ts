/**
 * The single loopback-only rule for relaxing the HTTPS-only guard (D-16).
 *
 * `oauth4webapi` refuses plain-http authorization servers unless
 * `allowInsecureRequests` is set. The CLI must never set that flag
 * unconditionally: it is derived from the URL being called and is true ONLY
 * for plain `http:` to a loopback host, which never leaves the machine.
 * Everything else (https needs no flag; any other http host must stay refused;
 * anything unparseable) is `false`, so the guard is deny-by-default.
 *
 * Both `run` and `revoke`/`cleanup` use this helper, so the rule cannot drift.
 */

/** `URL.hostname` for `http://[::1]:5/` is the bracketed `[::1]`; accept both forms. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True iff `url` is plain `http:` AND its host is exactly localhost, 127.0.0.1 or [::1]. */
export function isLoopbackHttp(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
}
