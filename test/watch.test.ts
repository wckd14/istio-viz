import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startWatchServer } from "../src/watch.js";

const VS = (host: string) => `apiVersion: networking.istio.io/v1
kind: VirtualService
metadata: {name: t, namespace: d}
spec:
  hosts: [${host}]
  http:
  - route: [{destination: {host: a, port: {number: 80}}}]
---
apiVersion: v1
kind: Service
metadata: {name: a, namespace: d}
spec: {ports: [{port: 80}]}
`;

function get(url: string): Promise<string> {
  return fetch(url).then((r) => r.text());
}

/** Wait for one SSE event of the given type, with timeout. */
function waitForEvent(url: string, type: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort();
      rejectPromise(new Error(`timed out waiting for SSE "${type}"`));
    }, timeoutMs);
    fetch(url, { signal: ctrl.signal })
      .then(async (res) => {
        const reader = res.body!.getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          if (buf.includes(`event: ${type}`)) {
            clearTimeout(timer);
            ctrl.abort();
            resolvePromise(buf);
            return;
          }
        }
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) rejectPromise(e);
      });
  });
}

test("watch: serves report, rebuilds on change, pushes reload, survives broken input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "istio-viz-watch-"));
  fs.writeFileSync(path.join(dir, "app.yaml"), VS("alpha.example.com"));

  const handle = await startWatchServer([dir], { port: 0, log: () => {} });
  try {
    const first = await get(handle.url);
    assert.ok(first.includes("alpha.example.com"));
    assert.ok(first.includes("/__events"), "live-reload client injected");
    assert.ok(first.includes("sessionStorage"), "filter persistence injected");

    // change the file -> SSE reload event arrives and content updates
    const reload = waitForEvent(handle.url + "__events", "reload", 5000);
    fs.writeFileSync(path.join(dir, "app.yaml"), VS("beta.example.com"));
    await reload;
    const second = await get(handle.url);
    assert.ok(second.includes("beta.example.com"));
    assert.ok(!second.includes("alpha.example.com"));

    // broken YAML -> error page, server stays up
    const reload2 = waitForEvent(handle.url + "__events", "reload", 5000);
    fs.writeFileSync(path.join(dir, "app.yaml"), "kind: [unclosed\n");
    await reload2;
    const errPage = await get(handle.url);
    assert.match(errPage, /rebuild failed|YAML parse error|build error/i);

    // fixed again -> healthy report
    const reload3 = waitForEvent(handle.url + "__events", "reload", 5000);
    fs.writeFileSync(path.join(dir, "app.yaml"), VS("gamma.example.com"));
    await reload3;
    const third = await get(handle.url);
    assert.ok(third.includes("gamma.example.com"));
  } finally {
    await handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watch: non-yaml changes outside kustomize roots are ignored", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "istio-viz-watch2-"));
  fs.writeFileSync(path.join(dir, "app.yaml"), VS("alpha.example.com"));
  const handle = await startWatchServer([dir], { port: 0, log: () => {} });
  try {
    let rebuilt = false;
    waitForEvent(handle.url + "__events", "reload", 900).then(
      () => (rebuilt = true),
      () => {},
    );
    fs.writeFileSync(path.join(dir, "notes.txt"), "not yaml");
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(rebuilt, false);
  } finally {
    await handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
