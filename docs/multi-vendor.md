# Multi-vendor models (design)

Goal: each agent can run on any vendor's model, so an OpenAI model can audit a Claude one and the reverse. Local and
open-source models are supported through the same path.

## Decisions

- **One neutral message format.** The tool loop already speaks "blocks" (`text`, `tool_use`, `tool_result`). That stays the
  internal format. The Anthropic adapter passes it through unchanged; the OpenAI-compatible adapter translates it to chat
  completions (`tool_calls`, `role: tool`) and back. The orchestrator does not change shape.
- **Two adapters cover everything.** `ClaudeProvider` (Anthropic) and `OpenAIProvider` (any OpenAI-compatible API): OpenAI,
  Google Gemini (compatibility endpoint), xAI Grok, DeepSeek, and local servers such as Ollama and LM Studio, plus a "custom"
  address for services like OpenRouter. A `RouterProvider` picks the adapter per request from `vendor`.
- **Per-agent choice.** `Agent.model?: { vendor, model }`. Absent means "use my tier", which is the old behaviour and
  resolves to Anthropic. Nothing changes for an existing council.
- **Keys per vendor**, each encrypted with the OS secure storage in its own file (Anthropic keeps its existing file).
  Hosted vendors' addresses are fixed in code so a key can never be sent somewhere else. Only `local` and `custom` have an
  editable address, which must be https, or http on this machine only (loopback).
- **Money.** Prices are keyed by model id. A hosted model with no price is refused (as today) so budgets cannot be bypassed;
  local models are free. Cache discounts are Anthropic-specific; other vendors are billed at a conservative 50% read rate.
- **Tools.** A model that cannot call tools reliably stays chat-only. Hosted vendors default to tools on, local and custom
  default to off, and the user can change it per model.
- **Privacy.** The picker says plainly that the agent's prompts, including project files it reads, go to that vendor.

## Not covered

Anthropic-only features (prompt caching, extended thinking blocks, server-side fallbacks) are skipped for other vendors, so
those agents cost more per call. Vendor model lists go stale, so every list has a "type a model name" option.
Real vendor behaviour is verified only against a fake local server; live use is the user's own testing.
