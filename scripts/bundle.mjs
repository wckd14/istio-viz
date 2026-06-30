#!/usr/bin/env node
// Bundles the compiled CLI and stamps the package version into the binary.
// The version is injected as the `__ISTIO_VIZ_VERSION__` constant consumed by
// src/index.ts, so `istio-viz --version` reports the released tag rather than a
// hardcoded string. Run after `tsc` (dist/index.js must exist).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

await build({
  entryPoints: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: fileURLToPath(new URL("../dist/bundle.cjs", import.meta.url)),
  external: ["@resvg/resvg-js"],
  define: {
    __ISTIO_VIZ_VERSION__: JSON.stringify(pkg.version),
  },
});
