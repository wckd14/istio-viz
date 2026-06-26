# Dev environment for istio-viz. `make setup` is the one-shot entry point.

.DEFAULT_GOAL := help
.PHONY: help setup install build test link unlink clean

help: ## list available targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

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

clean: ## remove build output and dependencies
	rm -rf dist node_modules
