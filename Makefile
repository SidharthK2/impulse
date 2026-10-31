# Impulse. Needs cargo for the server and tests, and pnpm only for the web app in web/.
#
#   make start       build the web app, then run the release server on :8787 (OFFLINE, PORT, BOTS, DATA_DIR… apply)
#   make dev         Rust server (debug) on :8787 + Vite on :5173, both stopped on Ctrl+C
#   make test        cargo test for the whole workspace (it builds the server binary the HTTP tests start)
#   make web         install and build the web app
#   make typecheck   typecheck the web app
#   make fmt         format the Rust (rustfmt) and the web app (oxfmt)
#   make lint        what CI checks besides tests: formatting, clippy, oxlint, typecheck
#
# To start from an empty exchange, point DATA_DIR at a new directory (DATA_DIR=data-new make start)
# or move the old one aside (mv data data.old). Nothing here deletes data.

CARGO := cargo
# --ignore-workspace: web/ is its own pnpm project, even when a parent directory holds a pnpm workspace.
PNPM_WEB := pnpm --dir web

.PHONY: start dev test web typecheck fmt lint

web/node_modules/.modules.yaml: web/package.json web/pnpm-lock.yaml
	$(PNPM_WEB) install --ignore-workspace

web: web/node_modules/.modules.yaml
	$(PNPM_WEB) run build

start: web
	$(CARGO) run --release -p impulse-server

dev: web/node_modules/.modules.yaml
	@trap 'kill 0' EXIT; $(CARGO) run -p impulse-server & $(PNPM_WEB) run dev

test:
	$(CARGO) test

typecheck: web/node_modules/.modules.yaml
	$(PNPM_WEB) run typecheck

fmt: web/node_modules/.modules.yaml
	$(CARGO) fmt
	$(PNPM_WEB) run fmt

lint: web/node_modules/.modules.yaml
	$(CARGO) fmt --check
	$(CARGO) clippy --all-targets --locked -- -D warnings
	$(PNPM_WEB) run fmt:check
	$(PNPM_WEB) run lint
	$(PNPM_WEB) run typecheck
