# Portable targets: no rm/cd/&& so they also work with GNU make on Windows.
# Make isn't standard on Windows; every target has a root `pnpm <script>`
# equivalent (see package.json), e.g. `pnpm check`, `pnpm test:rust`.
PNPM ?= pnpm
CARGO ?= cargo
NODE ?= node
MANIFEST := apps/desktop/src-tauri/Cargo.toml

.PHONY: help install dev tauri-dev build tauri-build windows-installer preview typecheck lint test rust-prep test-rust fmt fmt-check clippy check clean

help:
	@echo "naiteh build targets"
	@echo ""
	@echo "  make install            Install JS dependencies"
	@echo "  make dev                Start Vite dev server"
	@echo "  make tauri-dev          Start the Tauri desktop app in dev mode"
	@echo "  make build              Build the frontend bundle"
	@echo "  make tauri-build        Build the Tauri desktop app"
	@echo "  make windows-installer  Build the Windows NSIS installer"
	@echo "  make preview            Preview the built frontend"
	@echo "  make typecheck          Run TypeScript checks"
	@echo "  make lint               Run ESLint"
	@echo "  make test               Run frontend tests"
	@echo "  make test-rust          Run Rust tests"
	@echo "  make fmt                Format Rust code"
	@echo "  make fmt-check          Check Rust formatting"
	@echo "  make clippy             Run clippy with -D warnings"
	@echo "  make check              Run everything CI runs (typecheck, lint, test,"
	@echo "                          fmt-check, clippy, test-rust)"
	@echo "  make clean              Remove frontend dist and Rust build artifacts"

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

windows-installer:
	$(PNPM) -C apps/desktop tauri build --bundles nsis

preview:
	$(PNPM) -C apps/desktop preview

typecheck:
	$(PNPM) typecheck

lint:
	$(PNPM) lint

test:
	$(PNPM) test

# tauri::generate_context! needs apps/desktop/dist; stub it if missing.
rust-prep:
	$(NODE) scripts/ensure-dist.mjs

test-rust: rust-prep
	$(CARGO) test --manifest-path $(MANIFEST) --all --all-features

fmt:
	$(CARGO) fmt --manifest-path $(MANIFEST) --all

fmt-check:
	$(CARGO) fmt --manifest-path $(MANIFEST) --all -- --check

clippy: rust-prep
	$(CARGO) clippy --manifest-path $(MANIFEST) --all-targets --all-features -- -D warnings

check: typecheck lint test fmt-check clippy test-rust

clean:
	$(PNPM) -C apps/desktop exec node -e "require('fs').rmSync('dist',{recursive:true,force:true})"
	$(CARGO) clean --manifest-path $(MANIFEST)
