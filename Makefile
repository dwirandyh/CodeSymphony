PNPM ?= pnpm
WORKTREE_DEV_STATE_DIR ?= .codesymphony/dev

.PHONY: help install stop-dev dev dev-runtime dev-web dev-desktop setup-android-streaming start-android-streaming db-generate db-migrate db-seed db-init build test lint setup-worktree setup-worktree-up stop-worktree-up

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
	@echo "  make setup-worktree PORT=N - Configure ports for this worktree (runtime=N, web=N+1000)"
	@echo "  make setup-worktree-up PORT=N - Configure ports, start dev detached, and wait until runtime+web are ready"
	@echo "  make stop-worktree-up PORT=N - Stop detached dev started for this worktree port"

install:
	$(PNPM) install

stop-dev:
	-@pkill -f "turbo run dev --parallel --filter=@codesymphony/runtime --filter=@codesymphony/web"
	-@pkill -f "pnpm --filter @codesymphony/runtime dev"
	-@pkill -f "tsx watch --env-file .env src/index.ts"
	-@pkill -f "tsx --env-file .env src/index.ts"
	-@pkill -f "pnpm --filter @codesymphony/runtime start"
	-@pkill -f "pnpm --filter @codesymphony/web dev"
	-@pkill -f "pnpm --filter @codesymphony/desktop dev"
	-@pkill -f "vite"
	-@pkill -f "tauri dev"

dev:
	$(PNPM) dev

dev-runtime:
	$(PNPM) dev:runtime

dev-web:
	$(PNPM) dev:web

dev-desktop:
	$(PNPM) dev:desktop

setup-android-streaming:
	./scripts/setup-ws-scrcpy.sh

start-android-streaming:
	./scripts/start-ws-scrcpy.sh

run: stop-dev
	$(PNPM) run run

run-runtime:
	$(PNPM) run:runtime

run-web:
	$(PNPM) run:web

db-generate:
	$(PNPM) db:generate

db-migrate:
	$(PNPM) db:migrate

db-seed:
	$(PNPM) db:seed

db-init: db-generate db-migrate db-seed

lint:
	$(PNPM) lint

test:
	$(PNPM) test

build:
	$(PNPM) build

setup-worktree:
ifndef PORT
	$(error PORT is required. Usage: make setup-worktree PORT=4322)
endif
	@RUNTIME_PORT=$(PORT); \
	WEB_PORT=$$(( $(PORT) + 1000 )); \
	echo "Setting up worktree ports..."; \
	echo "  Runtime : $$RUNTIME_PORT"; \
	echo "  Web     : $$WEB_PORT"; \
	echo "  API URL : auto-detected from browser hostname on runtime port $$RUNTIME_PORT"; \
	echo ""; \
	cp -n apps/runtime/.env.example apps/runtime/.env 2>/dev/null || true; \
	sed -i '' "s/^RUNTIME_PORT=.*/RUNTIME_PORT=$$RUNTIME_PORT/" apps/runtime/.env; \
	printf "VITE_DEV_PORT=%s\nVITE_RUNTIME_PORT=%s\n" "$$WEB_PORT" "$$RUNTIME_PORT" > apps/web/.env; \
	echo "Generating Prisma client..."; \
	$(PNPM) --filter @codesymphony/runtime prisma:generate; \
	echo "Applying Prisma migrations..."; \
	(cd apps/runtime && DATABASE_URL="file:./dev.db" $(PNPM) exec prisma migrate deploy); \
	echo "Generating route tree..."; \
	(cd apps/web && npx @tanstack/router-cli generate); \
	echo "Done! Run 'make dev' to start."

setup-worktree-up:
ifndef PORT
	$(error PORT is required. Usage: make setup-worktree-up PORT=4322)
endif
	@$(MAKE) setup-worktree PORT=$(PORT) PNPM='$(PNPM)'
	@RUNTIME_PORT=$(PORT); \
	WEB_PORT=$$(( $(PORT) + 1000 )); \
	STATE_DIR="$(WORKTREE_DEV_STATE_DIR)"; \
	LOG_PATH="$$STATE_DIR/dev-$$RUNTIME_PORT.log"; \
	PID_PATH="$$STATE_DIR/dev-$$RUNTIME_PORT.pid"; \
	mkdir -p "$$STATE_DIR"; \
	if [ -f "$$PID_PATH" ] && kill -0 "$$(cat "$$PID_PATH")" 2>/dev/null; then \
		echo "Detached dev already running for runtime port $$RUNTIME_PORT (pid $$(cat "$$PID_PATH"))"; \
	else \
		echo "Starting detached dev. Logs: $$LOG_PATH"; \
		nohup $(MAKE) dev PNPM='$(PNPM)' >"$$LOG_PATH" 2>&1 & \
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
	@RUNTIME_PORT=$(PORT); \
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
