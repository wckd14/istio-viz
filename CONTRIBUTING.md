# Contributing to istio-viz

Thank you for your interest in contributing.

## Development setup

```sh
git clone https://github.com/wckd14/istio-viz.git
cd istio-viz
make setup          # npm install + build + test + npm link
```

Prerequisites: **Node.js ≥ 20**, **npm**, and **kustomize** (or **kubectl**) on your PATH for the overlay tests to pass.

To install kustomize:
```sh
# macOS
brew install kustomize

# Linux (replace VERSION with latest from https://github.com/kubernetes-sigs/kustomize/releases)
curl -sL "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2FVERSION/kustomize_VERSION_linux_amd64.tar.gz" | tar xz
sudo mv kustomize /usr/local/bin/
```

## Day-to-day workflow

```sh
npm run dev -- render ./testdata/bookinfo --format text   # run from source
npm test                                                   # type-check + all tests
npm run build                                              # compile to dist/
```

The test suite is hermetic — it mocks `kubectl` via PATH injection and runs `kustomize build` against fixture overlays in `testdata/kustomize/`. No cluster access is required.

## Project layout

```
src/
  cluster.ts     live cluster backend (kubectl-based)
  loader.ts      YAML ingestion and kind classification
  kustomize.ts   kustomize overlay detection and build
  hosts.ts       Istio host/wildcard semantics
  resolve.ts     graph construction and lint analysis
  trace.ts       Envoy-style request evaluation
  watch.ts       live HTTP server with SSE reload
  render/        renderers (html, svg, dot, text, layout)
  index.ts       CLI entry point
test/            unit and acceptance tests
testdata/        bookinfo, shop, and kustomize fixture manifests
```

## Making changes

- **Bugfix**: open an issue first if the behaviour is non-obvious, then a PR.
- **New feature**: open an issue to discuss scope and design before coding — larger changes should align with [SPEC.md](./SPEC.md).
- **Tests**: all changes must keep `npm test` green. New behaviour needs new test cases in `test/`.
- **Code style**: the project uses TypeScript strict mode. Run `npm run build` to catch type errors before pushing.

## Pull request checklist

- [ ] `npm test` passes locally
- [ ] New or modified behaviour is covered by tests
- [ ] Public-facing changes (new flags, new output formats, new findings) are documented in the README
- [ ] Spec changes are reflected in SPEC.md

## Commit author setup

Before your first commit, configure git with your public identity so the history is clean when the repo is public:

```sh
git config user.name  "Your Name"
git config user.email "you@example.com"   # use a personal or public address, not a work one
```

If you need to rewrite author information in existing commits before making the repository public, use `git-filter-repo` (the recommended modern replacement for `filter-branch`):

```sh
pip install git-filter-repo
git filter-repo --commit-callback '
    if commit.author_email == b"old@work.com":
        commit.author_email  = b"new@personal.com"
        commit.committer_email = b"new@personal.com"
'
```

## Reporting issues

Open a GitHub issue with:
1. The command you ran (sanitise any sensitive hostnames/paths)
2. The output or error message
3. The relevant portion of your manifest (Gateway + VirtualService + Service at minimum), with hostnames anonymised if needed

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
