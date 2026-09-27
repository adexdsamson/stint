import type { Manifest } from "../src/generated/manifest.js";

/**
 * The D-32 payment-reconciler manifest: hybrid auth mode, Paystack transactions
 * read, orders sheet read/write, resource_query verifier. Also ships as
 * spec/vectors/valid/payment-reconciler.json and ALP.md's annotated example.
 * Returns a fresh object every call so tests can freely mutate the result.
 */
export function paymentReconcilerManifest(): Manifest {
  return {
    spec_version: "alp/0.1",
    agent: {
      id: "payment-reconciler",
      name: "Payment Reconciler",
      description: "Reconciles Paystack transactions against the orders sheet.",
    },
    publisher: {
      id: "reconciler-labs.example",
      name: "Reconciler Labs",
    },
    version: "0.1.0",
    job: {
      description: "Match settled Paystack transactions to open orders and mark matched orders as paid.",
      verifier: {
        type: "resource_query",
        resource: "sheets.orders",
        predicate: "count(rows where status = 'reconciled') >= 1",
      },
    },
    scopes: [
      { resource: "paystack.transactions", access: ["read"] },
      { resource: "sheets.orders", access: ["read", "write"] },
    ],
    lease: { max_duration_seconds: 3600 },
    limits: {
      max_actions: 500,
      actions_per_hour: 300,
      error_threshold: { count: 5, window_seconds: 300 },
    },
    approvals: { require_for: ["irreversible"], timeout_seconds: 120 },
    auth: {
      mode: "hybrid",
      delegated: [
        { provider: "paystack", resources: ["paystack.transactions"] },
        { provider: "google_sheets", resources: ["sheets.orders"] },
      ],
      hosted: { license_issuer: "reconciler-labs.example", kid: "2026-09" },
    },
    cleanup: {
      hook: { url: "https://reconciler-labs.example/alp/cleanup" },
      publisher_retains: "aggregates",
    },
  };
}
