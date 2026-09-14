# Vendored contracts

## `observatory_metrics_item.json`

**Canonical home: [`mcp-observatory`](https://github.com/rajatarun/mcp-observatory/blob/main/contracts/observatory_metrics_item.json)** — `contracts/observatory_metrics_item.json` in that repository.

The copy in this directory is **verbatim and must stay verbatim**. Do not edit it
here. If the contract needs to change — a new namespace, a new reader, a changed
invariant — change it in `mcp-observatory` and re-vendor the result into every
consumer repository, keeping the `version` string in step.

### Why a copy at all

The shared `OBSERVATORY_METRICS` DynamoDB table (provisioned by the
`tarun-teamweave-shared` stack) has **many writers in two languages** and
**several dashboard readers**, none of which can see each other's source. The
item shape is therefore a cross-repository interface. It is pinned in one place
rather than in any single consumer, and each consumer vendors a copy so its own
conformance test can run offline with no cross-repo dependency at build time.

A writer that gets the shape wrong usually fails **silently**: a mis-spelled key
attribute is rejected by `PutItem` with a `ValidationException` that a writer
swallowing exceptions reports as success, and a row written under a namespace or
discriminator no reader enumerates is durable, billable and permanently
invisible to every dashboard. Neither shows up as an error anywhere. The only
defence is that each repository checks itself against this file.

### `conformance.ts`

A dependency-free port of `mcp-observatory`'s `contracts/conformance.py`.
The Python module cannot be imported from Node, so the checks are reimplemented
here — but against **the same JSON file**, so the two languages cannot drift on
what the contract says, only on how they read it.

Keep the two implementations in step: if you change a check in one, change it in
the other.

| Export | Purpose |
|---|---|
| `loadContract(path?)` | Read the contract JSON sitting beside the checker. |
| `unwrap(value)` | Accept both plain values (Python `boto3.resource` writers) and the low-level DynamoDB AttributeValue shape `{ S: "..." }` (the Node writers here). |
| `checkItem(item, contract?)` | Return an array of I1–I4 violations; `[]` means conforming. |
| `readersFor(pk, contract?)` | Which readers will ever see a row at this `pk`. `[]` is the machine-readable form of "written, billed, never read". |

Invariants checked: **I1** key attributes spelled lower-case `pk`/`sk` · **I2**
`pk` namespace is in `namespace_registry` · **I3** `sk` is
`{iso8601}#{trace_id}` · **I4** `ttl` present.

(`I5` — "a writer's namespace has at least one reader" — is a platform-level
property rather than a per-item one, so it is asserted through `readersFor` in
the conformance test rather than by `checkItem`.)

### Conformance test

`src/__tests__/observatory-contract.test.ts` drives **the real write path** in
`src/storage/ObservatoryMetricsStore.ts` with the DynamoDB client mocked, captures the
actual `PutItemCommand` `Item`, and asserts it against this contract.

RoutineWeave writes `pk: OBSERVATORY#invoke_model` — a discriminator that **is**
on the readers' enumerated list, so its rows are visible to the dashboards. The
test asserts that too, via `readersFor`, so a future change that silently moves
these rows into an unread partition is caught here.
