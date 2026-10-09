# Habitat Ax Core

Server-side AI routing and task orchestration for Habitat. API keys stay on the server; never bundle provider keys into the Android APK.

## Start locally

```bash
npm install
npm start
```

Set at least one provider key in the server environment. Provider keys are optional individually; Habitat skips providers without keys and tries configured providers in order.

| Environment variable | Provider | Default model |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini API | `gemini-2.5-flash` |
| `GROQ_API_KEY` | Groq OpenAI-compatible API | `openai/gpt-oss-20b` |
| `CEREBRAS_API_KEY` | Cerebras OpenAI-compatible API | `gpt-oss-120b` |
| `OPENROUTER_API_KEY` | OpenRouter | `openrouter/free` |

Optional model overrides: `GEMINI_MODEL`, `GROQ_MODEL`, and `CEREBRAS_MODEL`. Keep the defaults unless the selected provider's current model catalog confirms another model is available to your account.

## Operational endpoints

- `GET /` — basic backend status.
- `GET /health` — basic health status.
- `GET /diagnostics/providers` — shows which provider keys are configured and selected model names. It never returns secrets and does not spend model quota.
- `GET /diagnostics/provider` — checks OpenRouter API authorization/catalog access; this endpoint does not prove that chat generation quota is available.
- `POST /chat` — chat endpoint.
- `POST /device/heartbeat` and `GET /device/status` — Android heartbeat/status.

Configure the Android app's backend URL to your deployed Habitat API. Do not put provider secrets inside the APK or in client-side configuration.

## Important limits

Provider fallbacks improve resilience only when another configured provider has usable quota and access. They cannot bypass exhausted account quotas, revoked keys, provider outages, or model access restrictions. Check `/diagnostics/providers` first, then review server logs for the actual provider error. A configured key is not proof of successful inference.
