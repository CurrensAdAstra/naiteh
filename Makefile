PNPM ?= pnpm
CARGO ?= cargo
TAURI_DIR := apps/desktop/src-tauri

.PHONY: help install dev tauri-dev build tauri-build preview typecheck lint test test-rust check clean

help:
	@echo "naiteh build targets"
	@echo ""
	@echo "  make install      Install JS dependencies"
	@echo "  make dev          Start Vite dev server"
	@echo "  make tauri-dev    Start the Tauri desktop app in dev mode"
	@echo "  make build        Build the frontend bundle"
	@echo "  make tauri-build  Build the Tauri desktop app"
	@echo "  make preview      Preview the built frontend"
	@echo "  make typecheck    Run TypeScript checks"
	@echo "  make lint         Run ESLint"
	@echo "  make test         Run frontend tests"
	@echo "  make test-rust    Run Rust tests"
	@echo "  make check        Run typecheck, lint, frontend tests, and Rust tests"
	@echo "  make clean        Remove frontend dist and Rust build artifacts"

install:
	$(PNPM) install

dev:
	$(PNPM) dev

tauri-dev:
	$(PNPM) tauri dev

build:
	$(PNPM) build

tauri-build:
	$(PNPM) tauri build

preview:
	$(PNPM) -C apps/desktop preview

typecheck:
	$(PNPM) typecheck

lint:
	$(PNPM) lint

test:
	$(PNPM) test

test-rust:
	cd $(TAURI_DIR) && $(CARGO) test

check: typecheck lint test test-rust

clean:
	rm -rf apps/desktop/dist
	cd $(TAURI_DIR) && $(CARGO) clean
