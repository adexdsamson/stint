# @stint/cli

`stint-cli` installs, runs and cleanly uninstalls specialist AI agents under a lease. The lifecycle commands are `create`, `run`, `revoke`, `cleanup`, `receipts` and `verify`, and `inspect` shows one lease. The root [README](../../README.md) walks through them with a runnable example. This page is the guide for two commands that go beyond that walkthrough: the ninth command, `stint-cli verify-outcome`, which is how you complete a lease whose job is done, and the eighth, `stint-cli supervise`, the operator guide for a store that keeps leases for a long time. It also states, in one place, what happens to an API key you give Stint.

## Checking an outcome with `stint-cli verify-outcome`

```sh
stint-cli verify-outcome <leaseId> [--profile <file>]
```

`verify-outcome` evaluates the lease's outcome verifier once, on your say-so. A pass completes the lease through the same receipted path as any other completion and runs teardown, and the command prints `Outcome verified for lease <id>; the lease is now <state>.` A check that does not pass changes nothing about the lease: it stays `active`, you can fix the cause and run the check again, and the only trace is one denied receipt.

Only you complete a lease this way. An agent can ask for the check, but it cannot run one and it cannot complete the lease (see the agent signal below).

What it evaluates depends on the manifest's `job.verifier`:

- `resource_query`: the runtime reads through the lease's read binding and judges the answer in code. For a payment-confirmation job the read is a Paystack transaction lookup, and the runtime computes a closed verdict from the answer and the job parameters you entered at consent. The agent's own words are never an input. This verifier needs the run profile that names the read binding, so `--profile <file>` is required.
- `user_confirm`: Stint asks you at the terminal and a yes completes the lease. It needs no profile. The prompt is bounded by the manifest's `approvals.timeout_seconds`, and no answer in time is a failed check.
- `none`: there is nothing to check. The command exits 2 and points you at `stint-cli revoke`.

The global flags work as for every command (`--store <dir>`, `--json`). The command has one option of its own:

| Option | Meaning |
| --- | --- |
| `--profile <file>` | The run profile, as for `stint-cli run`. Required for a `resource_query` verifier, ignored for `user_confirm`. For the payment job it binds the read tool to the built-in `"rowAdapter": "verdict"` adapter. |

### What it prints and the exit codes

Every line is fixed text. A lease id, a lease state and the closed verdict value are the only values it ever shows. It never prints the reference, an amount, a customer detail, the API key or any text from the provider.

| Code | Meaning |
| --- | --- |
| 0 | The check passed, the lease is completed and teardown ran. A rotate line follows on stderr for a credential that cannot be revoked upstream. |
| 9 | The check did not pass and the lease stays `active`, or the lease is not active, so there is nothing to check. |
| 2 | Usage error: `--profile` is missing for a `resource_query` verifier, or the verifier is `none`. |
| 4 | The lease does not exist. |

A failed check with a verdict prints, on stderr:

```text
stint: The outcome check for lease <id> did not pass (verdict: amount_mismatch); the lease stays active.
```

The verdict is one of `confirmed`, `amount_mismatch`, `currency_mismatch`, `not_success`, `not_found` or `unknown`. Only `confirmed` passes. `unknown` is the fail-closed answer: the provider reported a status or a shape Stint does not recognize, so the check does not pass rather than guess. A failed check with no verdict (a rejected confirmation, a timeout, or a provider read that failed) prints the same line without the parenthesis. A read that failed (a rate limit, an outage, a network error) is a failed check too, exit 9: it never ends the lease, and you can run the command again.

Under `--json` the command prints one object on stdout instead: `{"leaseId":"...","outcome":"verified","state":"..."}` on a pass, and `{"leaseId":"...","outcome":"not_passed","verdict":"..."}` otherwise, with `verdict` present only when there is one.

### The agent can only ask

An agent connected through `stint-cli run` has one extra tool, `request_outcome_check`. Calling it writes a receipt and prints a notice on the terminal where the run is served:

```text
stint: the agent asked for an outcome check; run: stint-cli verify-outcome <id>
```

That is all it does. It is notice-only: it reads nothing, completes nothing and starts no teardown, so a prompt-injected agent cannot declare its own job done. The notice names the command without `--profile`, so add it yourself for a `resource_query` verifier. On a lease that is not active the call is denied and no notice is shown.

## API keys: what Stint does with the one you give it

Some providers use a static API key instead of an OAuth grant. Paystack is the one provider Stint knows by name. The contract is the same everywhere a key appears:

1. **You enter it once.** At `create`, pass `--api-key` and Stint asks for the key for each delegated provider that uses one, with the answer not shown as you type (the prompt reads `Enter the API key for <resource> (not shown as you type):`). `--api-key` is a switch: it takes no value, and there is no flag, argument or environment variable that carries a key. For a script, put the key in the credentials file you pass with `--credentials <file>`, as an entry `{ "<resource>": { "kind": "api_key", "key": "sk_test_..." } }`. Keep that file readable by you only and delete it when you are done. Without `--api-key` nothing is asked, and a prompt you leave unanswered skips that credential rather than failing the create.
2. **Only the runtime holds it.** It is copied into the credential store (a plaintext file store for now, and the command says so on stderr), never into a receipt, a lease record, the manifest or any output. Receipts hold hashes and redacted summaries only.
3. **It goes to one origin.** At create time the key is bound to a single provider origin: the entry's `origin` if you set one (https, or loopback http for a test), else the run profile's `providerOrigins`, else Stint's built-in table, which maps `paystack` to `https://api.paystack.co`. A key with no origin it can be bound to is refused before consent. At call time a request to any other origin is refused before it is sent.
4. **It never follows a redirect.** Every outbound request, with a key or an OAuth token attached, refuses a redirect instead of following it, so a provider cannot bounce the key to another host.
5. **The agent never sees it.** It is never returned to the agent, never in a tool result, and the Paystack verification the agent can trigger returns a short allowlist of fields plus the verdict, not the provider's response.
6. **You rotate it, after teardown.** An API key cannot be revoked through Stint. Consent shows it as a credential that cannot be revoked and asks you to acknowledge that. When the lease ends, teardown drops Stint's copy, records `discarded_revocation_unsupported`, and the lease ends `cleaned_up (credential not revoked upstream)` with one rotate line per resource. The key stays valid at the provider until you rotate it in the provider's dashboard. Do that after teardown.

Job parameters work the other way round. A manifest can declare typed inputs (`job.parameters`: a `string`, an `integer` or a `currency`) that you type at `create`. Each is validated, shown on the consent screen, and bound to the lease for good. They are not secrets, and an agent can never supply or change them.

## What `stint-cli supervise` does

`supervise` looks after every lease in one store, with no other user action. On each sweep it:

- settles a lease whose time ran out and tears it down,
- retries a teardown that did not finish, with a growing wait between tries,
- resumes a teardown that a crash cut short, without repeating a step that already succeeded,
- asks the provider whether the grant of an idle lease was revoked, and tears the lease down when it was,
- reports a lease record it cannot read, and leaves that record alone,
- pauses settling lease expiry after a forward jump of the system clock, until you confirm the clock.

Expiry does not depend on the supervisor. `run` still checks the lease on every call and denies a call after the lease ended or expired, whether or not a supervisor is running. The supervisor makes sure the teardown happens even when nobody is serving the lease.

## Running it

Without flags it runs until it is stopped. It sweeps, waits `--sweep-interval` seconds, and sweeps again.

```sh
stint-cli supervise
```

With `--once` it runs a single sweep and exits. That is the mode for cron or any scheduler that starts a new process each time.

```sh
stint-cli supervise --once
```

The store is the one the other commands use: `--store <dir>`, else `$STINT_HOME`, else `~/.stint`. A background service should set one of them on purpose, because a service often runs with a different home directory than your shell.

Press Ctrl-C to stop the long-running mode. The supervisor finishes the step it is in, starts nothing new, releases its locks and exits 0. A second Ctrl-C ends it at once; on Windows that immediate stop is exit code 1, because a hard re-raise cannot run exit handlers.

On Windows there is also a startup window: from process start until the first sweep begins (module loading, opening the store, taking the lock), a Ctrl-C is handled by the OS default console handler, not by the supervisor. PowerShell then reports exit code `-1073741510` (`0xC000013A`, STATUS_CONTROL_C_EXIT) and the process stops at once. Nothing is corrupted: no lease has been touched yet, and a lock left behind by such a stop goes stale and is recovered by the next start, exactly like any hard stop. `--once` and the other commands never listen for signals, so the same exit code applies to a Ctrl-C there. Ctrl+Break behaves like Ctrl-C in the long-running mode.

Only one supervisor runs per store, in either mode. A second one waits about 12 seconds (the 10 second lock stale time plus 2 seconds) and then exits 8 with `Another supervisor is already running on this store.` The wait lets a restart after a hard stop take over a lock the dead process left behind. If a running supervisor loses its lock, it stops sweeping and exits 8 with `The supervisor lock was lost; stopping.`

## Flags

`--store <dir>` and `--json` are global and work before or after `supervise`. Every number is a whole number of seconds unless noted. A bad value is a usage error (exit 2) that names the flag, and it is reported before the store is touched.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--once` | off | Run one sweep and exit. |
| `--sweep-interval <seconds>` | 30 | Seconds between sweeps in the long-running mode. 1 to 2147483. |
| `--retry-base <seconds>` | 60 | Wait before the first retry of an incomplete teardown. The wait doubles with each failed retry. 1 to 2147483. |
| `--retry-max <seconds>` | 3600 | The longest wait between retries. 1 to 2147483, and not smaller than `--retry-base`. |
| `--retry-cap <count>` | 8 | Retries before the lease is marked stuck. 1 to 1000. |
| `--probe-interval <seconds>` | 900 | Seconds between grant probes of an idle lease. 0 turns probing off. 0 to 2147483. |
| `--corrupt-repeat <seconds>` | 86400 | Seconds before an unchanged corrupt record is reported again. 1 to 2147483. |
| `--clock-jump-threshold <seconds>` | 3600 | How far the clock may jump forward, beyond the time that really passed, before expiry is paused. 1 to 2147483. |
| `--confirm-clock` | off | Confirm the system clock after a reported jump. It writes the confirmation and exits. It cannot be combined with `--once`. |
| `--json` | off | Print one JSON object per event on stdout instead of human lines on stderr. |
| `--store <dir>` | `$STINT_HOME` or `~/.stint` | The store to supervise. |

## Output

Output is quiet. A sweep that changes nothing prints nothing, and the long-running mode prints no startup line and no heartbeat. Each action prints one line on stderr, for example:

```text
stint: Lease 01J... expired and was settled.
stint: Lease 01J... teardown finished: cleaned_up.
stint: Lease 01J... teardown retried (attempt 2): cleanup_incomplete.
```

Under `--json` the same actions are one JSON object per line on stdout, with an `event` field: `expired`, `torn_down`, `retried`, `stuck`, `grant_revoked`, `corrupt_record`, `lease_error`, `clock_paused`, `clock_confirmed`, `clock_marker_unreadable` and `sweep_failed`. `--confirm-clock` prints `clock_confirm_written` or `no_clock_pause`. A usage error or a refusal is still printed on stderr.

Every line is fixed text. At most it carries a lease id, a closed reason or state word, or a number. It never carries a secret, a token, the content of a stored record or text from a provider. It is safe to ship the output to a log collector.

### Exit codes of `--once`

| Code | Meaning |
| --- | --- |
| 0 | Nothing is left to do, or everything found was handled. |
| 7 | At least one lease is stuck. See below. |
| 8 | Another supervisor holds the store, or this one lost the lock. |
| 10 | A lease record is corrupt, or the clock pause marker cannot be read. This wins over 7. |

Exit 1 is an internal error and exit 2 is a usage error. The long-running mode does not exit for a stuck or corrupt lease. It exits 0 when you stop it, 8 when its lock is lost, and 1 or 2 for an internal or usage error.

## Stuck leases

A teardown that cannot finish by itself is marked stuck. The marker is a `teardown_stuck` receipt, written once per cause. The lease keeps its state, so `stint-cli inspect <id>` shows `<state> (stuck: <reason>)`, for example `cleanup_incomplete (stuck: retries_exhausted)`, and `stint-cli receipts <id>` shows the marker. The supervisor prints the reason and the fix once per run, and `--once` exits 7 on every run while any lease is stuck.

There is no command to abandon a stuck lease or to declare its credential handled. A stuck lease stays visible until a real fix lets teardown finish.

| Reason | What happened | Fix |
| --- | --- | --- |
| `credentials_unavailable` | The credentials the lease recorded are not in the store. | `stint-cli cleanup <id> --credentials <file>` |
| `retries_exhausted` | Teardown stayed incomplete after the retry cap. | Read `stint-cli receipts <id>`, fix the cause, then `stint-cli cleanup <id>`. |
| `revocation_failed` | A credential could not be revoked at the provider. Stint dropped its own copy after the attempt, so retrying cannot help. | Rotate the credential in the provider dashboard, then `stint-cli cleanup <id>`. |
| `manifest_invalid` | The stored manifest no longer verifies against your trust store. | Restore the publisher key, then `stint-cli cleanup <id>`. |

For the first and the last reason the supervisor checks again on every sweep, and it resumes teardown on its own once the cause is gone.

The retry schedule is 60 seconds doubling to at most 3600 seconds, for 8 retries. The waits are 60, 120, 240, 480, 960, 1920, 3600 and 3600 seconds, so a lease that keeps failing is retried for about 3 hours before it is marked stuck. `--retry-base`, `--retry-max` and `--retry-cap` change that.

## Idle grant probes

A lease that sits idle never refreshes its tokens, so the provider could revoke the grant and nobody would notice until the next call. To catch that, the supervisor probes an active, unexpired lease that has been idle for `--probe-interval` seconds (900, or 15 minutes, by default). `--probe-interval 0` turns probing off.

A probe is one real refresh-token exchange with the provider. Be aware of what that means:

- A provider that rotates refresh tokens hands back a new one. Stint stores it before it does anything else, so the lease never loses its only valid token.
- The request shows up in the provider's logs and counts against its rate limits.
- A lease that holds only API keys, or a credential with no refresh token, is not probed.

Only a definite refusal ends a lease. A single `invalid_grant` answer (a 4xx status other than 429, or a 401 `invalid_token`) is enough. The supervisor then prints `Lease <id>: the provider revoked the grant; tearing the lease down.` and runs the normal teardown. An answer of 5xx or 429, a network error, a timeout (15 seconds per request) and a reply it cannot read never end a lease. They only delay the next probe: the wait doubles from 60 seconds up to the probe interval, and a `Retry-After` header is honoured.

Because one answer is enough, a probe can end a lease whose grant is not really gone. Known causes:

- The provider expires refresh tokens after a period of inactivity, and the lease was idle.
- The provider or the account restricts sign-in by IP address or by login hours, and the supervisor's machine is outside them.
- A provider outage that answers with `invalid_grant` instead of a 5xx.

If your provider has any of these, raise `--probe-interval` or turn probing off with `--probe-interval 0`. A lease ended by a false positive stays ended. Create a new lease.

A probe never runs beside a live `stint-cli run` of the same lease. A `run` writes a heartbeat every 10 seconds, and the supervisor skips a lease whose heartbeat is less than 45 seconds old, because probing beside a run could reuse a rotating token. A `run` also probes its own idle lease every 900 seconds, and when its lease ends for any reason it tears the lease down itself.

Under cron, each `--once` run is a fresh supervisor with no memory. It probes every idle lease whose last activity is more than `--probe-interval` seconds old, whatever happened in the run before. A job that runs every 5 minutes therefore probes an old idle lease every 5 minutes. Schedule `--once` no more often than you want probes, or pass `--probe-interval 0` to the cron job and leave probing to a long-running supervisor.

## Crash recovery

One driver at a time owns a teardown. It holds a fence on the lease record that lasts 120 seconds and is renewed at every step. If the owner dies, the fence lapses after at most 120 seconds. The next driver to try (a supervisor sweep, `cleanup`, `revoke` or a `run`) takes the teardown over, writes a `teardown_takeover` receipt (shown by `receipts` as `teardown takeover: epoch 1 -> 2 (fence_expired)`) and carries on from the receipts. A step that is already recorded never runs again. The one step that was in flight at the moment of the crash may run again, so a publisher cleanup hook should be safe to call twice.

`revoke` and `cleanup` wait up to 30 seconds for another live driver to finish. If the fence is still held after that, they exit 8 with `Another process is tearing down this lease. Wait for it to finish, then run: stint-cli cleanup <id>`. After a crash, a fence can have up to 120 seconds left, so run the command again a little later.

A hard stop is recovered the same way. Task Scheduler "End", `taskkill`, a SIGKILL and a SIGTERM do not let the supervisor clean up. The fence lapses after its 120 seconds, and the supervisor lock goes stale after 10 seconds, so a restarted supervisor takes over by itself. Nothing is lost, but the teardown that was running is delayed.

## The clock guard

Every lease looks expired if the system clock is set forward. To stop a bad clock from ending every lease at once, the supervisor compares the wall clock with a monotonic clock between two sweeps. When the wall clock moved forward by more than `--clock-jump-threshold` seconds (3600 by default) beyond the time that really passed, it prints:

```text
stint: The system clock jumped forward by 7200 seconds; lease expiry is paused. If the clock is correct, run: stint-cli supervise --confirm-clock
```

While the pause lasts, a lease past its `expiresAt` stays `active` and gets no receipt. Everything else carries on: retries, teardown of leases that already ended, and probes of leases that have not expired. `run` is not affected. It checks the wall clock on every call as before.

If the clock is correct (the machine was really offline for a long time, say), confirm it:

```sh
stint-cli supervise --confirm-clock
```

This takes no lock and asks nothing, so it works from another terminal or from a script while the supervisor runs. The running supervisor accepts the confirmation on its next sweep, which is at most one `--sweep-interval` later, and settles the expired leases then. If no supervisor is running, the next one to start accepts it. When no pause is active it prints `No clock pause is active.` and writes nothing. If the clock is wrong, fix the clock instead and the pause stays until you confirm it.

The pause is a file, `supervisor/clock-pause.json` in the store, and the confirmation is `supervisor/clock-confirm.json`. Both are small `{ "v": 1 }` JSON files. A confirmation only applies to the pause it was written for. Because the pause is a file, it survives a restart and a `--once` run honours it. Every new run prints the pause line once, so a cron job under a standing pause prints it on every run and still exits 0. If `clock-pause.json` cannot be read, expiry stays paused, `--once` exits 10, and `--confirm-clock` refuses with exit 10. Check the clock, then remove that file from the store.

Limits:

- On Linux and macOS the monotonic clock stops while the machine sleeps. A sleep longer than the threshold looks like a forward jump and pauses expiry until you run `--confirm-clock`. Raise `--clock-jump-threshold` on a laptop if that gets in the way.
- A `--once` run and a freshly started supervisor have no earlier reading to compare with, so they cannot detect a jump. They do honour a pause that is already recorded.
- A jump backward is not detected.

## Running it as a service

Stint ships no install command, and `supervise` has no abandon command and no status command. Use your operating system's scheduler. The examples below are standard ones, so change the paths to match your machine. None of them holds a credential: the supervisor takes credentials only from the store.

### Windows Task Scheduler

Create a task that starts the supervisor when you log on:

```text
schtasks /Create /TN "Stint supervisor" /SC ONLOGON /RL LIMITED /TR "C:\path\to\stint-cli.cmd supervise"
```

Then open the task in Task Scheduler and, under Settings, turn on "If the task fails, restart every" with a few minutes and 3 or more attempts. Turn off "Stop the task if it runs longer than", because by default Task Scheduler ends a task after 3 days and that is a hard stop. Task Scheduler "End" and `taskkill` are hard stops too. The fence and the lock go stale, as described under crash recovery, and the next start takes over.

Two Windows facts to check while you are in those Settings. First, untick "Start the task only if the computer is on AC power": it is on by default, `schtasks` has no switch to clear it, and on a laptop or a desktop on a UPS the task then never starts at all. Second, "restart every" only restarts failures Task Scheduler sees itself, and a supervisor killed by `taskkill`, Task Scheduler "End" or a plain nonzero exit was not restarted in testing. The dependable restart is a recurring trigger instead: the `--once` pattern below, or a `supervise` start every few minutes (a start while one is already running exits 8 and is harmless).

If you would rather not keep a process running, schedule `--once` instead:

```text
schtasks /Create /TN "Stint supervisor" /SC MINUTE /MO 15 /TR "C:\path\to\stint-cli.cmd supervise --once"
```

### systemd

Save this as `~/.config/systemd/user/stint-supervisor.service`:

```ini
[Unit]
Description=Stint supervisor

[Service]
Environment=STINT_HOME=%h/.stint
ExecStart=/usr/local/bin/stint-cli supervise
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=2
KillSignal=SIGINT
TimeoutStopSec=90

[Install]
WantedBy=default.target
```

`KillSignal=SIGINT` matters. The supervisor stops cleanly on SIGINT and SIGHUP, but it does not handle SIGTERM, which is what systemd sends by default and which would be a hard stop. Then enable it:

```sh
systemctl --user enable --now stint-supervisor.service
```

To keep a user service running after you log out, run `loginctl enable-linger` once.

### launchd

Save this as `~/Library/LaunchAgents/dev.stint.supervisor.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.stint.supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/stint-cli</string>
    <string>supervise</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
```

`stint-cli` needs `node` on its `PATH`, and launchd gives a job only a short `PATH`, so set it as shown. `KeepAlive` with `SuccessfulExit` set to false restarts the supervisor after a failure but not after a clean stop. launchd stops a job with SIGTERM, which the supervisor does not handle, so a stop from launchd is a hard stop that the fence and lock recovery cover. Load it with:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.stint.supervisor.plist
```

### cron

Use `--once` where you cannot keep a process running. Put the job in a small script so the exit code can raise an alert. cron has a short `PATH`, so use full paths.

```sh
#!/bin/sh
# /usr/local/bin/stint-supervise-cron
/usr/local/bin/stint-cli supervise --once 2>>"$HOME/.stint/supervise.log"
code=$?
case "$code" in
  0) ;;
  7) your-alert-command "stint: a lease is stuck, see $HOME/.stint/supervise.log" ;;
  10) your-alert-command "stint: a lease record or the clock marker is corrupt, see $HOME/.stint/supervise.log" ;;
  *) your-alert-command "stint: supervise exited with $code" ;;
esac
```

```text
*/15 * * * * /usr/local/bin/stint-supervise-cron
```

Exit 7 means a lease is stuck and needs one of the fixes above. Exit 10 means a record or the clock marker needs a look. Both repeat on every run until fixed, so a cron job alerts every time. A `--once` run keeps no memory between runs: it re-reports every corrupt record and re-announces every stuck lease each time, and it probes as described under idle grant probes. It cannot detect a clock jump, though it honours a pause that a long-running supervisor recorded.

## Related behaviour of the other commands

- `stint-cli run` stops on its own when its lease ends, whatever the reason. It prints `stint: Lease ended (<reason>); stopping.` on stderr, tears the lease down, and exits 0. `<reason>` is one of `expired`, `revoked`, `completed`, `failed` or `unavailable`.
- `stint-cli revoke` and `stint-cli cleanup` wait up to 30 seconds for another driver and then exit 8, as described under crash recovery.
- `stint-cli inspect` shows `(stuck: <reason>)` after the state of a stuck lease.
