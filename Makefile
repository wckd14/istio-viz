# Dev environment for istio-viz. `make setup` is the one-shot entry point.

.DEFAULT_GOAL := help
.PHONY: help setup install build test link unlink dev-link dev-unlink demo clean

# npm's global bin dir (e.g. /opt/homebrew/bin) — where the dev shim is installed.
DEV_BIN := $(shell npm prefix -g)/bin

help: ## list available targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

setup: install build test link ## install deps, build, test, and put `istio-viz` on the PATH

install: ## install npm dependencies
	npm install

build: ## compile TypeScript to dist/
	npm run build
	@chmod +x dist/index.js

test: ## type-check and run the test suite
	npm test

link: build ## symlink the compiled CLI onto the PATH (npm link)
	npm link
	@echo "istio-viz available at: $$(command -v istio-viz)"

unlink: ## remove the global symlink
	npm unlink -g istio-viz

dev-link: node_modules ## bind `istio-viz` to live src via tsx (no build; edits apply instantly)
	@printf '#!/usr/bin/env sh\n# istio-viz dev shim — runs live source, regenerate with `make dev-link`\nexec "%s/node_modules/.bin/tsx" "%s/src/index.ts" "$$@"\n' "$(CURDIR)" "$(CURDIR)" > "$(DEV_BIN)/istio-viz"
	@chmod +x "$(DEV_BIN)/istio-viz"
	@echo "dev shim -> $(DEV_BIN)/istio-viz runs $(CURDIR)/src/index.ts"
	@echo "active istio-viz: $$(command -v istio-viz)"
	@command -v istio-viz | grep -q "^$(DEV_BIN)/" || echo "WARNING: $(DEV_BIN) is not first on PATH; another istio-viz still wins"

dev-unlink: ## remove the dev shim
	@rm -f "$(DEV_BIN)/istio-viz"
	@echo "removed dev shim from $(DEV_BIN)"

demo: node_modules ## regenerate the live demo (site/demo.html) embedded on the landing page
	node --import tsx src/index.ts trace \
		testdata/acme/00-gateways.yaml testdata/acme/01-services.yaml \
		testdata/acme/02-destinationrules.yaml testdata/acme/10-vs-web.yaml \
		testdata/acme/11-vs-api.yaml testdata/acme/12-vs-grpc.yaml \
		testdata/acme/20-mesh.yaml testdata/acme/30-l4.yaml \
		--host api.acme.com --path /v2/orders --method POST --header x-canary=true \
		--format html -o site/demo.html

node_modules: ## ensure dependencies are installed (used as a prerequisite)
	npm install

clean: ## remove build output and dependencies
	rm -rf dist node_modules
