PNPM ?= pnpm

.PHONY: help install stop-dev dev dev-runtime dev-web dev-desktop db-generate db-migrate db-seed db-init build test lint

help:
	@echo "Available targets:"
	@echo "  make install       - Install workspace dependencies"
	@echo "  make stop-dev      - Stop local runtime/web/desktop dev processes"
	@echo "  make dev           - Run runtime + web"
	@echo "  make dev-runtime   - Run runtime only"
	@echo "  make dev-web       - Run web only"
	@echo "  make dev-desktop   - Run desktop shell"
	@echo "  make db-generate   - Generate Prisma client"
	@echo "  make db-migrate    - Run Prisma migrations"
	@echo "  make db-seed       - Seed the database"
	@echo "  make db-init       - Generate + migrate + seed"
	@echo "  make lint          - Run typecheck/lint across workspace"
	@echo "  make test          - Run tests across workspace"
	@echo "  make build         - Build all workspace packages/apps"

install:
	$(PNPM) install

stop-dev:
	-@pkill -f "turbo run dev --parallel --filter=@codesymphony/runtime --filter=@codesymphony/web"
	-@pkill -f "tsx watch --env-file .env src/index.ts"
	-@pkill -f "pnpm --filter @codesymphony/web dev"
	-@pkill -f "pnpm --filter @codesymphony/desktop dev"
	-@pkill -f "vite"
	-@pkill -f "tauri dev"

dev: stop-dev
	$(PNPM) dev

dev-runtime:
	$(PNPM) dev:runtime

dev-web:
	$(PNPM) dev:web

dev-desktop:
	$(PNPM) dev:desktop

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
