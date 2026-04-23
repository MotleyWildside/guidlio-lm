# Custom Logger

`GuidlioLMService` emits structured log entries for every call, retry, and cache event. By default it discards all output. Inject an `LLMLogger` implementation to route those entries to your existing logging infrastructure — whether that is `pino`, `winston`, a container-friendly JSON stream, or anything else.

## Concepts covered

- The `LLMLogger` interface: `info`, `warn`, `error` with `(message, meta?)` signatures
- A `PinoAdapter` wrapping `pino` — forwarding `meta` as pino's binding object
- A `WinstonAdapter` wrapping `winston` — forwarding `meta` as the second argument
- A `StructuredJsonLogger` writing line-delimited JSON to stdout for containers and Lambda
- Why `meta.responseBody` should not be logged (model output may contain sensitive data)
- Injecting a logger via `GuidlioLMServiceConfig.logger`

## The LLMLogger interface

```typescript
interface LLMLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}
```

The interface is intentionally narrow. Each method receives a human-readable `message` and an optional flat `meta` object containing structured fields (`traceId`, `promptId`, `model`, `durationMs`, etc.). Do not log `meta.responseBody` — the service does not include it, but if you extend the interface you should honour this contract: model output may contain personal data or confidential content.

## PinoAdapter

```typescript
import type pino from "pino";
import type { LLMLogger } from "guidlio-lm";

// pino is a peer dependency — install it alongside guidlio-lm:
// npm install pino

export class PinoAdapter implements LLMLogger {
	private logger: pino.Logger;

	constructor(logger: pino.Logger) {
		this.logger = logger;
	}

	info(message: string, meta?: Record<string, unknown>): void {
		// pino's API is logger.info(bindings, message) — meta spreads as structured fields
		this.logger.info(meta ?? {}, message);
	}

	warn(message: string, meta?: Record<string, unknown>): void {
		this.logger.warn(meta ?? {}, message);
	}

	error(message: string, meta?: Record<string, unknown>): void {
		this.logger.error(meta ?? {}, message);
	}
}
```

Usage:

```typescript
import pino from "pino";
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";
import { PinoAdapter } from "./PinoAdapter";

const pinoInstance = pino({ level: "info" });

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: new PromptRegistry(),
	logger: new PinoAdapter(pinoInstance),
});
```

## WinstonAdapter

```typescript
import type winston from "winston";
import type { LLMLogger } from "guidlio-lm";

// winston is a peer dependency — install it alongside guidlio-lm:
// npm install winston

export class WinstonAdapter implements LLMLogger {
	private logger: winston.Logger;

	constructor(logger: winston.Logger) {
		this.logger = logger;
	}

	info(message: string, meta?: Record<string, unknown>): void {
		// winston's logger.info(message, meta) attaches meta as structured fields
		this.logger.info(message, meta);
	}

	warn(message: string, meta?: Record<string, unknown>): void {
		this.logger.warn(message, meta);
	}

	error(message: string, meta?: Record<string, unknown>): void {
		this.logger.error(message, meta);
	}
}
```

Usage:

```typescript
import winston from "winston";
import { WinstonAdapter } from "./WinstonAdapter";

const winstonInstance = winston.createLogger({
	level: "info",
	transports: [new winston.transports.Console()],
	format: winston.format.json(),
});

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: new PromptRegistry(),
	logger: new WinstonAdapter(winstonInstance),
});
```

## StructuredJsonLogger

For containerised workloads and Lambda functions where a log aggregator reads stdout line-by-line, write plain newline-delimited JSON with no dependencies.

```typescript
import type { LLMLogger } from "guidlio-lm";

type LogLevel = "info" | "warn" | "error";

export class StructuredJsonLogger implements LLMLogger {
	private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
		const entry: Record<string, unknown> = {
			level,
			message,
			timestamp: new Date().toISOString(),
			...meta,
		};
		// process.stdout.write is synchronous-safe in Node; console.log adds a newline
		process.stdout.write(JSON.stringify(entry) + "\n");
	}

	info(message: string, meta?: Record<string, unknown>): void {
		this.write("info", message, meta);
	}

	warn(message: string, meta?: Record<string, unknown>): void {
		this.write("warn", message, meta);
	}

	error(message: string, meta?: Record<string, unknown>): void {
		this.write("error", message, meta);
	}
}
```

Sample output for a successful call:

```json
{"level":"info","message":"llm call","timestamp":"2026-04-23T10:00:00.000Z","traceId":"trace_abc","promptId":"summarize","promptVersion":1,"model":"gpt-4o-mini","provider":"openai","success":true,"cached":false,"durationMs":412,"usage":{"promptTokens":83,"completionTokens":42,"totalTokens":125}}
```

Usage:

```typescript
import { GuidlioLMService, OpenAIProvider, PromptRegistry } from "guidlio-lm";
import { StructuredJsonLogger } from "./StructuredJsonLogger";

const llm = new GuidlioLMService({
	providers: [new OpenAIProvider(process.env.OPENAI_API_KEY!)],
	promptRegistry: new PromptRegistry(),
	logger: new StructuredJsonLogger(),
});
```

## What the service logs

| Event | Level | Notable meta fields |
| :--- | :--- | :--- |
| Successful call | `info` | `traceId`, `promptId`, `model`, `provider`, `durationMs`, `usage`, `cached` |
| Retry attempt | `warn` | `traceId`, `attempt`, `maxAttempts`, `retryDelayMs`, `error` |
| Retries exhausted | `error` | `traceId`, `attempt`, `error` |
| Provider fallback | `warn` | `requestedProvider`, `resolvedProvider` (when `defaultProvider` name doesn't match) |
| Cache read/write | `info` | `key`, `hit` (boolean), `ttlSeconds` |

## What to change next

- See how log entries look for retry events — see [07-providers-and-errors.md](../07-providers-and-errors.md).
- If you want to suppress all logging in tests, pass `logger: undefined` (the default) or a no-op implementation.
