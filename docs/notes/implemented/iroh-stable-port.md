# Implemented: the Iroh ticket's direct addresses survive a restart

- **Problem:** `iroh-secret.key` kept the NodeId stable, but every start bound a random UDP port,
  and the ticket embeds the direct addresses with that port. A client holding an old ticket could
  reach the server only through the relay (32 s to 70+ s from China to a US-West relay).
- **Decision:** `IrohServer._bind_endpoint` remembers the bound IPv4 port in `iroh-port.txt` beside
  the key and binds it again via `EndpointOptions.bind_addr="0.0.0.0:PORT"`. `TRPG_TUI__IROH_PORT`
  pins it and wins over the sidecar. A port that cannot be bound falls back to a random one, logs
  that the ticket changes this time, and rewrites the sidecar. No secret path (loopback/tests) binds
  as before. The sidecar lives with the keys, not in room state, so no lifecycle facet claims it.
- **Reason:** `bind_addr` is one `host:port` string and pins one socket family; `0.0.0.0` fixes IPv4
  and the IPv6 socket stays random (checked against `Endpoint.bound_sockets()`). IPv4 is the path
  that matters for a returning client. A custom `iroh.Preset` can call `bind_addr` twice to pin both
  families on one port (verified working in iroh 1.1); not done, as the extra failure mode (a host
  without IPv6 failing a pinned `[::]` bind) was not worth it. The OS only releases the UDP port when
  the endpoint handle is dropped, not at `close()`, so tests release it before rebinding.
- **Rule home:** `net/iroh_server.py` (`IrohServer._bind_endpoint`), `docs/deploy.md` ("A ticket that
  survives restarts").
- **Date:** 2026-10-21.
