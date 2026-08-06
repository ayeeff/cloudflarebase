# DbGateway: one client socket for the whole database

Status: IMPLEMENTED (drafted 2026-08-05; approved and built 2026-08-05 -
"standardize realtime for nosql and sql, DX first")

> **Deviations from the draft, for future readers:**
>
> - **Gateways are regional**: instances are `<pid>:gw:<region>:<n>` (not
>   `<pid>:gw:<n>`), created with the SUBSCRIBER'S region as the
>   locationHint - the socket terminates near the client (user requirement),
>   and only the shard->gateway delivery RPC crosses regions.
> - **Sibling routing is the replica mechanism verbatim, not a connection
>   hash**: gateways report step-debounced socket counts to the project
>   parent (`gateways` registry), the worker asks `gatewaySubscribeTarget`
>   behind the same isolate cache, and `pickSubscribeSibling` fills the
>   lowest sibling with headroom. Demo projects never spawn siblings.
> - **The snapshot is the `remoteSubscribe` return value** (no separate
>   frame round-trip); the shard stores via-subscriptions in its normal
>   `subscriptions` table under a `via` column and delivers through
>   `gatewayDeliver` batched per connection in `waitUntil` - never on the
>   write's latency path. `{stop}` answers prune dead connections; a
>   token-expired error frame prunes the gateway's own row as it passes.
> - **Replica-hosted subscriptions**: with replication auto the gateway
>   registers on `:r:<region>:1`; a replica that cannot bootstrap answers
>   `{ forward: true }` and the gateway retries the primary - routing
>   staleness stays a latency wobble.
> - **Origin gating at accept**: the gateway checks Origin against the
>   environment allowlist plus the project's per-project origins (fetched
>   from the parent, cached 60s). Authorization stays entirely shard-side.
> - **SDK default is the gateway** (`realtime: 'auto'`): one transport per
>   client multiplexes every `collection()`/`table()` subscription; if the
>   endpoint has NEVER answered (an agent predating gateways), subscriptions
>   fall back to per-shard sockets permanently for that client.
>   `collection<T>()` also gained the same type parameter tables have.
> - **Observability**: `GET /admin/realtime` lists the gateway registry
>   (id, region, sockets, last seen). Caps: 100 subscriptions per gateway
>   connection (25 on demo projects); per-shard caps unchanged.
> - Pinned by `e2e/db-gateway.api.spec.ts` (multi-shard fan-in, replica
>   delivery, JWT parity, kind mismatches, sibling spawn).

Today the SDK opens one WebSocket **per shard** (collection or table). A
client watching 6 collections and 2 tables holds 8 sockets. The ask: one
socket per client that multiplexes live queries over the ENTIRE database -
documents and SQL rows - like Firestore's single streaming channel.

## Shape

A new plain-DO class **`DbGateway`** (raw hibernation API, same `LiveShard`
discipline, deliberately not an SDK Agent), instances named
`<projectId>:gw:<n>`. Clients connect to
`/agents/db-agent/<pid>/realtime` (worker hot path, one hop); frames extend
the existing zod protocol with a shard address:

```
subscribe   { id, shard: { kind: 'collection'|'table', name }, query, token? }
snapshot    { id, docs }        // unchanged
change      { id, kind, doc }   // unchanged
```

One socket, N subscriptions across any mix of shards; the SDK keeps its
per-subscription API and just stops opening sockets.

## Delivery: shards push RESOLVED frames to the gateway (RPC, never sockets)

The REP2 lesson holds: an outgoing socket dies with hibernation exactly when
delivery must happen. So the gateway never subscribes outward. Instead:

- On `subscribe`, the gateway RPCs the shard (its region replica when
  replication is on - same routing the worker already does):
  `remoteSubscribe({ gateway: '<pid>:gw:<n>', connId, subId, query, claims })`.
  The shard stores it in its existing durable `subscriptions` table with a
  `via` column (gateway name + connId), runs the SAME live engine over its
  own data - predicate diffs, windowed displacement, owner scoping, token
  expiry - and answers the snapshot inline.
- On every write, subscriptions with `via` deliver by RPC
  (`gatewayDeliver(connId, frames)`) instead of a local socket send. The RPC
  wakes a hibernated gateway, which forwards to the right client socket.
  Exactly the primary->replica push pattern, one level up.
- Socket close / token expiry: the gateway RPCs `remoteUnsubscribe`; the
  shard's `{stop}`-style answer on a dead gateway heals stale rows, like
  push flags.

Why the shard keeps running the query: live queries NEED the shard's data
(windowed re-runs, displacement, snapshots). The gateway holds zero data and
zero query state - it is a durable fan-out table (`connId -> socket`,
`subId -> shard`) and nothing else, so it hibernates cheaply and never
becomes a second source of truth.

## Scale

- Gateways shard by connection hash: the worker routes a new socket to
  `gw:<hash(connId) % width>`, width grows under socket pressure with the
  SAME `pickSubscribeSibling` mechanism replicas use (reported socket
  counts, spawn threshold, cap). ~32k sockets per gateway instance, spread
  across N instances and regions (`gw` instances take a locationHint like
  replicas - a client talks to a nearby gateway; the shard->gateway RPC
  crosses regions, which is the cost replicas already pay in reverse).
- Per-write fan-out cost: one RPC per gateway instance holding matching
  subscriptions (batched frames per gateway, not per subscription) - the
  shard already iterates matching subscriptions today; the delivery leg
  changes, not the matching.
- The per-shard sockets go away entirely for SDK users; direct per-shard
  `/subscribe` stays for raw-WebSocket users and the dashboard.

## Access control

The gateway is dumb on purpose: the SHARD verifies the JWT and enforces
modes/permissions per subscription exactly as it does for direct sockets
(claims travel in `remoteSubscribe`; the shard re-verifies, never trusts the
gateway). Public shards keep working tokenless. The gateway's only check is
frame shape.

## Failure modes

- Gateway dies/restarts: clients reconnect (fresh snapshots - the v1 rule
  already), shards heal `via` rows on the next delivery failure.
- Shard unreachable at subscribe: `error { code: 'shard-unavailable' }` on
  that subId only; the socket and other subscriptions live on.
- Ordering: per-subscription frames stay ordered (single-threaded shard,
  single RPC lane per gateway); cross-shard ordering is NOT promised - same
  as today with per-shard sockets.

## Build plan (roughly one T-phase)

1. `DbGateway` class + worker route + `gw` sibling routing (reuses
   `pickSubscribeSibling`).
2. `via` column + `remoteSubscribe`/`remoteUnsubscribe`/`gatewayDeliver`
   RPCs in `LiveShard` (one implementation, both engines inherit).
3. SDK: `db.realtime()` transport that multiplexes existing `collection()`/
   `table()` subscriptions over one socket; per-shard sockets remain as the
   fallback.
4. e2e: multi-shard fan-in over one socket, gateway hibernation wake, JWT
   gate parity, gateway sibling spawn under the test threshold.
