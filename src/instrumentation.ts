/*
 * OpenTelemetry bootstrap for light-run.
 *
 * Imported at the very top of bin/light-run.ts so the SDK is registered
 * before any user code (Fastify, route handlers, light-runner) starts
 * emitting spans. Without this hoist, child-side spans would still be
 * recorded but the SDK's instrumentations would not have hooked the
 * relevant modules yet.
 *
 * Opt-in: starts only when `LIGHT_RUN_OTEL_DEBUG=1` (console exporter) or
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set (OTLP). Otherwise the SDK is
 * constructed (cheap) but never `start()`-ed, so every `tracer.startSpan(...)`
 * call from light-runner resolves to a NoopTracer.
 *
 * @fastify/otel is registered separately inside server.ts as a Fastify
 * plugin (the contrib instrumentation-fastify package was retired in
 * March 2026 and is no longer pulled by @opentelemetry/auto-instrumentations-node).
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'light-run';
const SERVICE_VERSION = process.env.LIGHT_RUN_VERSION ?? '0.4.0';

const debugMode = process.env.LIGHT_RUN_OTEL_DEBUG === '1';
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

/*
 * Three startup modes:
 *   1. LIGHT_RUN_OTEL_DEBUG=1 -> spans are printed to stdout via
 *      ConsoleSpanExporter. No backend needed, no metrics exported.
 *   2. OTEL_EXPORTER_OTLP_ENDPOINT=... -> traces + metrics go via OTLP/HTTP
 *      to the configured Collector or backend.
 *   3. Neither set -> SDK is constructed but never start()-ed, so every
 *      tracer call is a no-op and adds nothing at runtime.
 */

const traceExporter: SpanExporter = debugMode
  ? new ConsoleSpanExporter()
  : new OTLPTraceExporter();

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
  }),
  ...(debugMode
    ? { spanProcessors: [new SimpleSpanProcessor(traceExporter)] }
    : { traceExporter }),
  // Metrics only ship over OTLP. In debug-only mode (no endpoint) we skip the
  // reader entirely so nothing is pushed to a non-existent collector.
  ...(otlpEndpoint
    ? {
        metricReader: new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
        }),
      }
    : {}),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Quiet noisy filesystem spans - millions of inconsequential reads
      // overwhelm the trace UI without adding signal.
      '@opentelemetry/instrumentation-fs': { enabled: false },
      // instrumentation-fastify is intentionally NOT listed here: it was retired
      // from auto-instrumentations-node in March 2026, so its key no longer exists
      // in InstrumentationConfigMap and referencing it fails the build. @fastify/otel
      // (registered in server.ts) is its replacement.
    }),
  ],
});

if (debugMode || otlpEndpoint) {
  sdk.start();

  const shutdown = async (): Promise<void> => {
    try {
      await sdk.shutdown();
    } catch {
      /* swallow - best-effort flush on exit */
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export { sdk };
