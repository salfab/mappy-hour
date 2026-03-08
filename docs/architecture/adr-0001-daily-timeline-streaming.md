# ADR-0001 - Daily Timeline Streaming with SSE

Date: 2026-03-08
Status: Accepted

## Context

The existing `daily` mode computes sunlight over a whole day but returns an aggregated result (`sunnyMinutes`).
This does not let users inspect how sunlight and shadows evolve over time.

We need:

- temporal frames across the day
- progressive UX feedback during long calculations
- minimal additional CPU overhead
- no requirement to keep a separate worker infrastructure

## Decision

We stream daily timeline frames via Server-Sent Events (SSE):

1. backend endpoint: `GET /api/sunlight/timeline/stream`
2. one daily computation pass
3. for each sampled timestamp:
   - compute sunlight state for all outdoor points
   - emit one `frame` event
4. emit progress telemetry while computing:
   - `phase`, `done`, `total`, `percent`, `etaSeconds`
5. emit lifecycle events:
   - `start`, `progress`, `frame`, `done`, `error`

Frame payload uses a compact bitset (`sunMaskBase64`) instead of full boolean arrays.

## Rationale

- SSE works natively in browsers (`EventSource`) and in Next.js route handlers.
- It supports unidirectional server-to-client streaming, which matches this use case.
- Bitset payload reduces bandwidth and JSON parsing overhead.
- Progress updates are derived from existing loops (no extra ray/solar passes).

## Consequences

Positive:

- timeline slider can display real temporal evolution
- users get immediate progress and ETA feedback
- no websocket server or queue dependency required

Tradeoffs:

- SSE is one-way (client commands need separate HTTP calls)
- very large areas still need hard limits (`maxPoints`, raw grid cap)
- frontend must decode bitsets per frame

## Alternatives considered

1. Repeated `instant` requests:
   - simple but duplicates computations and network overhead
2. WebSocket streaming:
   - flexible bidirectional channel but higher complexity for current scope
3. Return all frames in one JSON response:
   - no progressive feedback and higher peak memory/latency
