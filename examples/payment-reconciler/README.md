# Payment reconciler example

A runnable example of the whole Agent Lease lifecycle on loopback, with mock services standing in for the authorization server, the publisher, Paystack and an orders sheet. It has two flows:

- **The reconciler quickstart.** One command, `pnpm example:payment-reconciler` from the repository root, runs a hybrid lease end to end and prints the receipts timeline. The root [README](../../README.md) explains what it does and how to read the output.
- **The payment-confirmation job.** A smaller, delegated lease where an agent confirms that one specific Paystack payment happened and you complete the lease yourself. This page documents it. It is run by the example's end-to-end suite, not by a `start` script.

> The runtime is experimental (`alp/0.1`). Nothing here is for production use yet.

## The payment-confirmation job

The manifest is delegated and read-only. It declares one scope, `paystack.transactions` with `read` access, and three typed job parameters:

| Parameter | Type | Meaning |
| --- | --- | --- |
| `reference` | `string` | The Paystack transaction reference to confirm. |
| `expected_amount_kobo` | `integer` | The amount you expect, in kobo (30050 is NGN 300.50). |
| `currency` | `currency` | The three-letter currency you expect, for example `NGN`. |

Its outcome verifier is a `resource_query` over `paystack.transactions` that passes only when the connector-computed verdict is `confirmed`. There is no publisher license and no cleanup hook, so this flow needs no publisher.

The arc, from consent to cleanup:

1. **Create.** `stint-cli create <manifest> --credentials <file>` asks you for each of the three parameters, one at a time, and checks each (a bad answer gets one retry, a second one declines the lease). The consent screen then shows the three values you entered above the credentials block, and lists the Paystack key as a credential that cannot be revoked. The key comes from the credentials file, an entry `{ "kind": "api_key", "key": "sk_test_..." }` for `paystack.transactions`. For interactive use, `--api-key` asks for it with no echo instead. Activation binds the parameters to the lease.
2. **Run.** `stint-cli run <id> --profile <file>` serves the lease. The profile binds one read tool, `verify_payment`, to the built-in `"rowAdapter": "verdict"` adapter. The agent calls it with no arguments. The runtime sends one GET to `https://api.paystack.co/transaction/verify/<reference>` with the key, using the reference you entered, never one the agent supplied. The agent gets back a `verdict` and the short allowlist of fields the connector keeps: not the customer, the authorization or the raw response.
3. **Ask for a check.** The agent may call `request_outcome_check`. This prints a notice on the serving terminal and nothing else. It cannot complete the lease.
4. **Verify the outcome.** You run `stint-cli verify-outcome <id> --profile <file>`. The runtime repeats the read and computes the verdict. `confirmed` completes the lease and runs teardown (exit 0). Anything else (`amount_mismatch`, `currency_mismatch`, `not_success`, `not_found`, `unknown`) leaves the lease active and exits 9 with the verdict. You can fix the cause and run the check again on the same lease. A rate limit or an outage from Paystack is a failed check, not the end of the lease.
5. **Cleanup.** Teardown drops Stint's copy of the key and records `discarded_revocation_unsupported`. The lease ends `cleaned_up (credential not revoked upstream)` and prints a line telling you to rotate the key.

**Rotate the key yourself.** Stint cannot revoke a Paystack key. After teardown the key still works at Paystack until you rotate it in the Paystack dashboard. Use a test-mode key for anything you try out.

## The end-to-end suite

```sh
pnpm test:e2e
```

This runs every suite in the example, from the repository root. For the payment-confirmation job:

- `test/e2e.payment-confirm.test.ts` **always runs**. It drives the whole arc above against a verify-capable mock Paystack on loopback: the confirmed flow, a mismatch followed by a corrected check on the same lease, an unknown reference, a 429 and a 500, every status the verdict maps, and the trap cases (a response whose envelope says success while the transaction failed). It also scans the consent screen, the agent's results, both receipt chains and the store after teardown for the key and for the fields the connector must hide, and finds none.
- `test/e2e.paystack-test-mode.test.ts` runs the same scenario against the real `https://api.paystack.co` in test mode. It is **opt-in** and is reported as skipped unless the environment variable `PAYSTACK_TEST_SECRET_KEY` is set. A skipped suite makes no network call and is not a failure, and nothing requires the real run for CI.

To run the real test-mode suite, put a Paystack **test** secret key in the environment for that one command:

```sh
PAYSTACK_TEST_SECRET_KEY=sk_test_... pnpm --filter @stint/example-payment-reconciler exec vitest run test/e2e.paystack-test-mode.test.ts
```

Rules for the key:

- Never commit it, put it in a file in the repository, or paste it into an issue. The suite reads it once, keeps it in memory, never prints it and never puts it in a message. A failing step reports the step name and an integer HTTP status only.
- A key that does not start with `sk_test_` is refused before any request, so a live key can never create a live transaction from here.
- The key is sent to one origin only, `https://api.paystack.co`, which is also what Stint's built-in provider table resolves `paystack` to. The suite's credentials entry names no origin in this mode.

What the real run does: it initializes a test transaction for 500 NGN, pays it with Paystack's published test card (4084 0840 8408 4081, PIN 0000, OTP 123456), then runs the payment-confirmation flow against that reference and expects a `confirmed` verdict, a `cleaned_up` lease and the rotate line. A second test checks that an unknown reference gives `not_found`.

The payment choreography follows Paystack's published documentation and has not yet been run against the live service. A first run with a real test key settles three facts that the test's header comment asks you to record: whether the charge endpoint accepts the initialized transaction's reference, the exact HTTP status for an unknown reference, and whether a successful test transaction carries `requested_amount` (Stint treats a success with no amount as `unknown`, which fails closed). If the real service differs, the choreography or the mock changes. The verdict rules do not.

## Layout

| Path | What it is |
| --- | --- |
| `src/quickstart.ts` | The reconciler quickstart behind `pnpm example:payment-reconciler`. |
| `src/payment-confirm.ts` | `runPaymentConfirmationScenario`, the payment-confirmation flow in hermetic or real mode. |
| `src/manifest.ts`, `src/profile.ts` | The signed manifests and the run profiles for both flows. |
| `src/mocks/` | The loopback mocks, including the verify-capable Paystack mock. |
| `test/` | The end-to-end suites and the README drift test. |
