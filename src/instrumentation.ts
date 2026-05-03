import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

export function register() {
  // Only initialise on the Node.js runtime (not edge).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.AXIOM_TOKEN) return;

  const sdk = new NodeSDK({
    serviceName: process.env.AXIOM_SERVICE_NAME ?? 'workgraph',
    traceExporter: new OTLPTraceExporter({
      url: 'https://api.axiom.co/v1/traces',
      headers: {
        Authorization: `Bearer ${process.env.AXIOM_TOKEN}`,
        'X-Axiom-Dataset': process.env.AXIOM_DATASET ?? 'workgraph',
      },
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem instrumentation is very noisy in Next.js builds.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
}
