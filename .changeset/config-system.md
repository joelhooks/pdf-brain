---
"pdf-brain": minor
---

Add config system with provider/model selection

- New config file at `$PDF_LIBRARY_PATH/config.json` for persistent settings
- CLI commands: `config show`, `config get <key>`, `config set <key> <value>`
- Configurable providers for embedding, enrichment, and judge LLMs
- Supports `ollama` (local) and `gateway` (AI Gateway) providers
- Auto-install ollama models when missing (configurable)
- API keys read from environment variables only (`AI_GATEWAY_API_KEY`)
- Fixed embedding model to `mxbai-embed-large` (1024 dimensions)
