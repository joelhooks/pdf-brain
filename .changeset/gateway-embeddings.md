---
"pdf-brain": minor
---

Add Vercel AI Gateway embedding support

- **New Feature**: Multi-provider embedding support with `EmbeddingProvider` abstraction layer
- **Gateway.ts**: New service using AI SDK for cloud embeddings (text-embedding-3-small via Vercel AI Gateway)
- **Config**: Use `embedding.provider: "gateway"` in config.json to switch from Ollama to Gateway
- **Performance**: Gateway embeddings are significantly faster than local Ollama for batch operations
- **Backwards Compatible**: Ollama remains the default provider

Configuration example:
```json
{
  "embedding": {
    "provider": "gateway",
    "model": "text-embedding-3-small"
  }
}
```

Requires `AI_GATEWAY_API_KEY` environment variable when using Gateway provider.
