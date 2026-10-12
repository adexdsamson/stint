/**
 * The single loopback-only rule for relaxing the HTTPS-only guard (D-16). The
 * implementation lives in `@stint/runtime` so every host shares one rule; this
 * module keeps the CLI's import path stable.
 */

export { isLoopbackHttp } from "@stint/runtime";
