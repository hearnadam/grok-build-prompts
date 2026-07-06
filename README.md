# grok-build-prompts

Tooling that extracts prompt components from a pinned Grok Build CLI binary.

Grok Build is distributed by xAI through the official installer at `https://x.ai/cli/install.sh`. The installer supports explicit versions, so this repo pins a known artifact instead of installing `latest`.

The binary is a native Mach-O executable. The extractor dynamically reads its Mach-O section table, finds `__TEXT,__const` and `__DATA_CONST,__const`, and reconstructs Rust string-slice records (`ptr`, `len`) that point to embedded prompt components.

## Quick Start

```sh
bun install
bun run download:grok
bun run extract
```

The scripts write:

- `vendor/grok/<version>/grok` - pinned local Grok Build binary, ignored by git.
- `prompts/<name>.md` - extracted prompt components.
- `skills/<name>.md` - extracted skill prompt components.
- `subagents/<name>.md` - extracted subagent prompt components, when present.
- `raw/` - command outputs and extraction metadata.
- the generated catalog below - an index linking to every generated file.

## Catalog

<!-- BEGIN GENERATED CATALOG -->

Source binary: vendor/grok/0.2.87/grok
Grok Build: grok 0.2.87 (0ae0bf47e53)
Previous generated version: grok 0.2.82 (6d0b07d2de0f)

Change summary:
- Added: 3
- Changed: 0
- Removed: 0
- Unchanged: 5

### Added

- [search-agent](prompts/search-agent.md)
- [search-agent-2](prompts/search-agent-2.md)
- [search-agent-3](prompts/search-agent-3.md)

### Changed

- (none)

### Removed

- (none)

Notes:
- The extractor dynamically parses Mach-O sections and uses Rust string-slice records for native prompt components.
- Short prompt fragments are intentionally excluded so generated folders are not polluted with one-line strings.
- Treat extracted files as embedded prompt components, not guaranteed fully composed runtime prompts.

## Prompts

- [code-verifier](prompts/code-verifier.md)
- [memory-incremental-update](prompts/memory-incremental-update.md)
- [search-agent](prompts/search-agent.md)
- [search-agent-2](prompts/search-agent-2.md)
- [search-agent-3](prompts/search-agent-3.md)
- [your-task-is-to-produce-a-faithful-concise-summary-of-the-conversation-s](prompts/your-task-is-to-produce-a-faithful-concise-summary-of-the-conversation-s.md)

## Subagents

- (none)

## Skills

- [search-agent](skills/search-agent.md)
- [skill-creator](skills/skill-creator.md)

## Raw Artifacts

- [grok --help](raw/grok-help.txt)
- [change summary](raw/change-summary.json)
- [Mach-O section metadata](raw/macho-sections.json)
- [Rust string slice metadata](raw/rust-string-slices.json)
- [prompt candidate metadata](raw/prompt-candidates.json)
<!-- END GENERATED CATALOG -->

## Bumping Grok Build

`package.json` stores the pinned Grok Build version under `grokBuild.version`. The workflow at `.github/workflows/update-grok.yml` checks `https://x.ai/cli/stable`, updates the exact pin, downloads the binary, runs extraction, opens a `grok-bump` PR, and requests auto-merge.

## Layout

```
scripts/download-grok.mjs       # downloads the pinned Grok binary
scripts/extract-grok-prompts.mjs # extractor
package.json                    # command manifest and pinned Grok version
.github/workflows/update-grok.yml
.github/workflows/regenerate-prompts.yml
prompts/                        # generated prompt components
skills/                         # generated skill prompt components
subagents/                      # generated subagent prompt components
raw/                            # generated metadata and raw CLI output
README.md                       # includes the generated catalog
```

## Caveats

- Extracted prompt files are embedded prompt components, not guaranteed fully composed runtime system prompts.
- Runtime prompts can be assembled from fragments and dynamic context; the extractor avoids publishing short one-line fragments as standalone prompts.
- `grok inspect --json` is useful for local debugging, but it includes user-local skills, plugins, hooks, and paths, so this repo does not commit it by default.
