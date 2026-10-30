# Impulse. Needs cargo for the server and tests, and pnpm only for the web app in web/.
#
#   make start       build the web app, then run the release server on :8787 (OFFLINE, PORT, BOTS, DATA_DIR… apply)
#   make dev         Rust server (debug) on :8787 + Vite on :5173, both stopped on Ctrl+C
#   make test        cargo test for the whole workspace (it builds the server binary the HTTP tests start)
#   make web         install and build the web app
#   make typecheck   typecheck the web app
#   make clean-data  how to start from an empty exchange (it never deletes data itself)

CARGO := cargo
# --ignore-workspace: web/ is its own pnpm project, even when a parent directory holds a pnpm workspace.
PNPM_WEB := pnpm --dir web

.PHONY: start dev test web typecheck clean-data

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

clean-data:
	@echo "The exchange lives in DATA_DIR (default data/). Nothing here deletes it. To start fresh, either"
	@echo "  point DATA_DIR at a new directory:   DATA_DIR=data-$$(date +%Y%m%d) make start"
	@echo "  or move the old one aside yourself:  mv data data.old"
