# Local tiny_http patch

Source: [tiny_http 0.12.0](https://crates.io/crates/tiny_http/0.12.0), upstream commit `212b1c45852fef2093dc1374875a9393c55eb4b9`.
Crate archive SHA-256: `389915df6413a2e74fb181895f933386023c71110878cd0825588928e64cdc82`.

The source tree, README and licenses are retained. Examples, benchmarks, integration-test assets and unused development dependencies are omitted. The manifest otherwise retains upstream dependencies/features; acom uses plain HTTP.

Runtime changes:

- `src/util/equal_reader.rs` discards unread request bodies through an 8 KiB scratch buffer instead of allocating the client-controlled remaining Content-Length.
- `src/request.rs` rejects EOF inside a nonzero chunk instead of accepting a truncated chunked body as complete. Its decoder wrapper preserves empty-buffer reads.

Discard still waits for unread bytes or disconnection; these changes are not request timeouts or general denial-of-service protection. Regressions cover bounded discard, exact body consumption, truncated/complete chunked bodies and empty-buffer reads:

```sh
cargo test --locked --offline -p tiny_http --lib
```

SHA-256 for `src/util/equal_reader.rs`:

- Upstream: `7d7916b42316d745c12185509fa5719dd9a032fef1c19fe8057b154f48e8db55`
- Patched, including regression: `02dda723b141d820e96e33899253b71abe3612dfff179d7b08dd42453b2ba673`

SHA-256 for `src/request.rs`:

- Upstream: `ef8fcf8d36706a0e1a146f3262917b4631ecf8db925408d4b6959a0d7423695a`
- Patched, including regressions: `76e4b5c4c4ba73fb3331133b98457281fd707ab6e4ea7a1f56aea353d1667c10`

Upstream MIT/Apache-2.0 licensing is unchanged; acom's notices select MIT.
