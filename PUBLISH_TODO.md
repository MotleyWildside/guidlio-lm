# 🚀 Publish Checklist: guidlio-lm

This list tracks the remaining tasks needed to prepare `guidlio-lm` for its first public release on NPM.

## 🟢 Completed

- [x] Initial project structure
- [x] Core logic (LLMService, Providers, Orchestrator)
- [x] Set up `.gitignore`
- [x] Define package metadata in `package.json` (author, repo, name)
- [x] Add `LICENSE` file (MIT)
- [x] Final README polish (Modern & Lightweight)
- [x] **Dual Build (CJS/ESM)**: Use `tsup` or similar to support older Node projects.

## 🟡 High Priority (Required for Release)

- [ ] **Setup Testing Framework**: Install Vitest and configure `npm test`.
- [ ] **Core Unit Tests**: Write tests for `LLMService`, `PromptRegistry`, and `PipelineOrchestrator`.
- [ ] **Provider Mocks**: Ensure tests don't make real API calls by default.
- [ ] **Build Validation**: Run `npm run build` and ensure the `dist/` folder contains everything needed (JS, d.ts).
- [ ] **Final README Polish**: Ensure all examples match the final `guidlio-lm` naming.

## 🔵 Medium Priority (Highly Recommended)

- [ ] **Examples Folder**: Create a directory with runnable standalone scripts (e.g., `examples/basic-chat.ts`).
- [ ] **GitHub Actions**: Setup CI to run tests on every push/PR.
- [ ] **CONTRIBUTING.md**: Guidelines for others who want to help.

## ⚪ Low Priority (Post-Release)

- [ ] **API Reference**: Generate documentation from JSDoc (using TypeDoc).
- [ ] **Vercel/Documentation Site**: A pretty landing page.
- [ ] **NPM Provenance**: Configure secure publishing via GitHub Actions.

---

> [!TIP]
> Focus on **Testing** next. A package with 0 tests is often a red flag for developers.
