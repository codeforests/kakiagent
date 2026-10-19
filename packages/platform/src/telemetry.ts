import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

/**
 * OpenTelemetry tracing for a runtime role (ADR-021). It only starts when an OTLP
 * endpoint is configured (the ADOT collector in AWS); locally it stays off unless you
 * point it at a collector. Span attributes carry IDs, never message text.
 */
export function startTelemetry(role: string, endpoint: string | undefined): () => Promise<void> {
  if (!endpoint) return async () => {};
  const sdk = new NodeSDK({
    serviceName: `kakiagent-${role}`,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });
  sdk.start();
  return () => sdk.shutdown();
}
