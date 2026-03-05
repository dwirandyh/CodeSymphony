PNPM ?= pnpm

.PHONY: help install stop-dev dev dev-runtime dev-web dev-desktop db-generate db-migrate db-seed db-init build test lint setup-worktree

help:
	@echo "Available targets:"
	@echo "  make install       - Install workspace dependencies"
	@echo "  make stop-dev      - Stop ALL local dev processes (use with care in multi-worktree setups)"
	@echo "  make dev           - Run runtime + web"
	@echo "  make dev-runtime   - Run runtime only"
	@echo "  make dev-web       - Run web only"
	@echo "  make dev-desktop   - Run desktop shell"
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

install:
	$(PNPM) install

stop-dev:
	-@pkill -f "turbo run dev --parallel --filter=@codesymphony/runtime --filter=@codesymphony/web"
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
	echo "  API URL : http://127.0.0.1:$$RUNTIME_PORT/api"; \
	echo ""; \
	cp -n apps/runtime/.env.example apps/runtime/.env 2>/dev/null || true; \
	sed -i '' "s/^RUNTIME_PORT=.*/RUNTIME_PORT=$$RUNTIME_PORT/" apps/runtime/.env; \
	printf "VITE_RUNTIME_URL=http://127.0.0.1:%s/api\nVITE_DEV_PORT=%s\n" \
	    "$$RUNTIME_PORT" "$$WEB_PORT" > apps/web/.env; \
	echo "Generating route tree..."; \
	npx --prefix apps/web @tanstack/router-cli generate; \
	echo "Done! Run 'make dev' to start."
