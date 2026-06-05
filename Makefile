BUN ?= $(shell if command -v bun >/dev/null 2>&1; then printf '%s' bun; elif [ -x "$$HOME/.bun/bin/bun" ]; then printf '%s' "$$HOME/.bun/bin/bun"; else printf '%s' bun; fi)
WORKTREE_DEV_STATE_DIR ?= .codesymphony/dev
MACOS_APP_PATH ?= apps/desktop/dist-electron/mac-arm64/CodeSymphony.app
MACOS_RESOLVE_SIGNING_IDENTITY_SCRIPT ?= apps/desktop/scripts/resolve-signing-identity.sh
MACOS_VERIFY_SIGNING_SCRIPT ?= apps/desktop/scripts/verify-macos-signing.sh
MACOS_BUILD_ENV_FILE ?= .env
TAILSCALE ?= $(shell if [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then printf '%s' "/Applications/Tailscale.app/Contents/MacOS/Tailscale"; elif command -v tailscale >/dev/null 2>&1; then command -v tailscale; else printf '%s' tailscale; fi)
TAILSCALE_APP_PORT ?= 4322

.PHONY: help install stop-dev dev dev-runtime dev-web dev-desktop setup-android-streaming start-android-streaming db-generate db-migrate db-seed db-init build test lint build-macos-prod build-macos-prod-app macos-signing-identity verify-macos-signing serve-macos-app serve-macos-app-status stop-serve-macos-app setup-worktree setup-worktree-up stop-worktree-up

help:
	@echo "Available targets:"
	@echo "  make install       - Install workspace dependencies"
	@echo "  make stop-dev      - Stop ALL local dev processes (use with care in multi-worktree setups)"
	@echo "  make dev           - Run runtime + web"
	@echo "  make dev-runtime   - Run runtime only"
	@echo "  make dev-web       - Run web only"
	@echo "  make dev-desktop   - Run desktop shell"
	@echo "  make setup-android-streaming - Bootstrap ws-scrcpy sidecar for Android streaming"
	@echo "  make start-android-streaming - Run the Android ws-scrcpy sidecar"
	@echo "  make run           - Run production runtime + web (builds first)"
	@echo "  make run-runtime   - Run production runtime only"
	@echo "  make run-web       - Run production web only"
	@echo "  make db-generate   - Generate Prisma client"
	@echo "  make db-migrate    - Run Prisma migrations"
	@echo "  make db-seed       - Seed the database"
	@echo "  make db-init       - Generate + migrate + seed"
	@echo "  make lint          - Run typecheck/lint across workspace"
	@echo "  make test          - Run tests across workspace"
	@echo "  make build         - Build all workspace packages/apps"
	@echo "  make macos-signing-identity - Print the macOS signing identity that will be used for release builds"
	@echo "  make build-macos-prod-app - Build a signed production macOS .app bundle"
	@echo "  make build-macos-prod - Build a signed production macOS .app bundle and DMG"
	@echo "  make verify-macos-signing - Verify the built macOS app and nested binaries are not ad-hoc signed"
	@echo "  make serve-macos-app - Expose macOS app runtime via Tailscale Serve"
	@echo "  make serve-macos-app-status - Show Tailscale Serve status"
	@echo "  make stop-serve-macos-app - Stop Tailscale Serve for this app"
	@echo "  make setup-worktree PORT=N - Configure ports for this worktree (runtime=N, web=N+1000)"
	@echo "  make setup-worktree-up PORT=N - Configure ports, start dev detached, and wait until runtime+web are ready"
	@echo "  make stop-worktree-up PORT=N - Stop detached dev started for this worktree port"
	@echo ""
	@echo "macOS release build notes:"
	@echo "  Local macOS build overrides can live in $(MACOS_BUILD_ENV_FILE) (gitignored)."
	@echo "  Override the signing identity with CODESYMPHONY_MACOS_SIGN_IDENTITY='Developer ID Application: ...'"
	@echo "  If no identity is set, the desktop build scripts auto-detect a usable non-adhoc identity."

install:
	$(BUN) install

stop-dev:
	-@pkill -f "turbo run dev --parallel --filter=@codesymphony/runtime --filter=@codesymphony/web"
	-@pkill -f "bun run --filter @codesymphony/runtime dev"
	-@pkill -f "bun --watch --env-file=.env src/index.ts"
	-@pkill -f "bun --env-file=.env src/index.ts"
	-@pkill -f "bun run --filter @codesymphony/runtime start"
	-@pkill -f "bun run --filter @codesymphony/web dev"
	-@pkill -f "bun run --filter @codesymphony/desktop dev"
	-@pkill -f "electron ."
	-@pkill -f "Electron"
	-@pkill -f "vite"

dev:
	$(BUN) run dev

dev-runtime:
	$(BUN) run dev:runtime

dev-web:
	$(BUN) run dev:web

dev-desktop:
	$(BUN) run dev:desktop

setup-android-streaming:
	./scripts/setup-ws-scrcpy.sh

start-android-streaming:
	./scripts/start-ws-scrcpy.sh

run: stop-dev
	$(BUN) run run

run-runtime:
	$(BUN) run run:runtime

run-web:
	$(BUN) run run:web

db-generate:
	$(BUN) run db:generate

db-migrate:
	$(BUN) run db:migrate

db-seed:
	$(BUN) run db:seed

db-init: db-generate db-migrate db-seed

lint:
	$(BUN) run lint

test:
	$(BUN) run test

build:
	$(BUN) run build

macos-signing-identity:
	@set -e; \
	set -a; \
	if [ -f "$(MACOS_BUILD_ENV_FILE)" ]; then . "$(MACOS_BUILD_ENV_FILE)"; fi; \
	set +a; \
	bash "$(MACOS_RESOLVE_SIGNING_IDENTITY_SCRIPT)"

build-macos-prod-app:
	@set -e; \
	set -a; \
	if [ -f "$(MACOS_BUILD_ENV_FILE)" ]; then . "$(MACOS_BUILD_ENV_FILE)"; fi; \
	set +a; \
	SIGNING_IDENTITY="$${CODESYMPHONY_MACOS_SIGN_IDENTITY:-$${APPLE_SIGNING_IDENTITY:-$$(bash "$(MACOS_RESOLVE_SIGNING_IDENTITY_SCRIPT)")}}"; \
	echo "Using macOS signing identity: $$SIGNING_IDENTITY"; \
	CODESYMPHONY_MACOS_SIGN_IDENTITY="$$SIGNING_IDENTITY" $(BUN) run --filter @codesymphony/desktop build:app

build-macos-prod:
	@set -e; \
	set -a; \
	if [ -f "$(MACOS_BUILD_ENV_FILE)" ]; then . "$(MACOS_BUILD_ENV_FILE)"; fi; \
	set +a; \
	SIGNING_IDENTITY="$${CODESYMPHONY_MACOS_SIGN_IDENTITY:-$${APPLE_SIGNING_IDENTITY:-$$(bash "$(MACOS_RESOLVE_SIGNING_IDENTITY_SCRIPT)")}}"; \
	echo "Using macOS signing identity: $$SIGNING_IDENTITY"; \
	CODESYMPHONY_MACOS_SIGN_IDENTITY="$$SIGNING_IDENTITY" $(BUN) run --filter @codesymphony/desktop build

verify-macos-signing:
	@set -e; \
	set -a; \
	if [ -f "$(MACOS_BUILD_ENV_FILE)" ]; then . "$(MACOS_BUILD_ENV_FILE)"; fi; \
	set +a; \
	SIGNING_IDENTITY="$${CODESYMPHONY_MACOS_SIGN_IDENTITY:-$${APPLE_SIGNING_IDENTITY:-$$(bash "$(MACOS_RESOLVE_SIGNING_IDENTITY_SCRIPT)")}}"; \
	echo "Verifying $(MACOS_APP_PATH)"; \
	CODESYMPHONY_MACOS_SIGN_IDENTITY="$$SIGNING_IDENTITY" bash "$(MACOS_VERIFY_SIGNING_SCRIPT)" "$(MACOS_APP_PATH)" "$$SIGNING_IDENTITY"

serve-macos-app:
	@set -e; \
	"$(TAILSCALE)" serve --bg $(TAILSCALE_APP_PORT); \
	"$(TAILSCALE)" serve status

serve-macos-app-status:
	@"$(TAILSCALE)" serve status

stop-serve-macos-app:
	@"$(TAILSCALE)" serve --https=443 off

setup-worktree:
ifndef PORT
	$(error PORT is required. Usage: make setup-worktree PORT=4322)
endif
	@set -e; \
	RUNTIME_PORT=$(PORT); \
	WEB_PORT=$$(( $(PORT) + 1000 )); \
	echo "Setting up worktree ports..."; \
	echo "  Runtime : $$RUNTIME_PORT"; \
	echo "  Web     : $$WEB_PORT"; \
	echo "  API URL : auto-detected from browser hostname on runtime port $$RUNTIME_PORT"; \
	echo ""; \
	if [ ! -d node_modules ]; then \
		echo "Installing workspace dependencies..."; \
		$(BUN) install; \
	fi; \
	cp -n apps/runtime/.env.example apps/runtime/.env 2>/dev/null || true; \
	sed -i '' "s/^RUNTIME_PORT=.*/RUNTIME_PORT=$$RUNTIME_PORT/" apps/runtime/.env; \
	printf "VITE_DEV_PORT=%s\nVITE_RUNTIME_PORT=%s\n" "$$WEB_PORT" "$$RUNTIME_PORT" > apps/web/.env; \
	echo "Generating Prisma client..."; \
	$(BUN) run --filter @codesymphony/runtime prisma:generate; \
	echo "Applying Prisma migrations..."; \
	(cd apps/runtime && DATABASE_URL="file:./dev.db" $(BUN) x prisma migrate deploy); \
	echo "Generating route tree..."; \
	(cd apps/web && $(BUN) x @tanstack/router-cli generate); \
	echo "Done! Run 'make dev' to start."

setup-worktree-up:
ifndef PORT
	$(error PORT is required. Usage: make setup-worktree-up PORT=4322)
endif
	@$(MAKE) setup-worktree PORT=$(PORT) BUN='$(BUN)'
	@set -e; \
	RUNTIME_PORT=$(PORT); \
	WEB_PORT=$$(( $(PORT) + 1000 )); \
	STATE_DIR="$(WORKTREE_DEV_STATE_DIR)"; \
	LOG_PATH="$$STATE_DIR/dev-$$RUNTIME_PORT.log"; \
	PID_PATH="$$STATE_DIR/dev-$$RUNTIME_PORT.pid"; \
	mkdir -p "$$STATE_DIR"; \
	if [ -f "$$PID_PATH" ] && kill -0 "$$(cat "$$PID_PATH")" 2>/dev/null; then \
		echo "Detached dev already running for runtime port $$RUNTIME_PORT (pid $$(cat "$$PID_PATH"))"; \
	else \
		echo "Starting detached dev. Logs: $$LOG_PATH"; \
		nohup $(MAKE) dev BUN='$(BUN)' >"$$LOG_PATH" 2>&1 & \
		echo $$! > "$$PID_PATH"; \
	fi; \
	echo "Waiting for runtime http://127.0.0.1:$$RUNTIME_PORT/health"; \
	echo "Waiting for web http://127.0.0.1:$$WEB_PORT"; \
	for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do \
		RUNTIME_READY=0; \
		WEB_READY=0; \
		curl -sf "http://127.0.0.1:$$RUNTIME_PORT/health" >/dev/null 2>&1 && RUNTIME_READY=1; \
		curl -sf "http://127.0.0.1:$$WEB_PORT" >/dev/null 2>&1 && WEB_READY=1; \
		if [ "$$RUNTIME_READY" -eq 1 ] && [ "$$WEB_READY" -eq 1 ]; then \
			echo "Ready."; \
			echo "  Runtime: http://127.0.0.1:$$RUNTIME_PORT"; \
			echo "  Web:     http://127.0.0.1:$$WEB_PORT"; \
			exit 0; \
		fi; \
		sleep 2; \
	done; \
	echo "Timed out waiting for dev services. Recent log output:"; \
	tail -n 80 "$$LOG_PATH"; \
	exit 1

stop-worktree-up:
ifndef PORT
	$(error PORT is required. Usage: make stop-worktree-up PORT=4322)
endif
	@set -e; \
	RUNTIME_PORT=$(PORT); \
	STATE_DIR="$(WORKTREE_DEV_STATE_DIR)"; \
	PID_PATH="$$STATE_DIR/dev-$$RUNTIME_PORT.pid"; \
	if [ ! -f "$$PID_PATH" ]; then \
		echo "No detached dev pid file found for runtime port $$RUNTIME_PORT"; \
		exit 0; \
	fi; \
	PID="$$(cat "$$PID_PATH")"; \
	if kill -0 "$$PID" 2>/dev/null; then \
		kill "$$PID" 2>/dev/null || true; \
		echo "Stopped detached dev pid $$PID for runtime port $$RUNTIME_PORT"; \
	else \
		echo "Detached dev pid $$PID is no longer running"; \
	fi; \
	rm -f "$$PID_PATH"
