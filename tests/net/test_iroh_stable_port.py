"""The Iroh ticket's DIRECT addresses survive a restart (stable UDP port).

`iroh-secret.key` fixes the NodeId, but a ticket also embeds the direct addresses, and a random
UDP port per start made every one of them dead after a restart. `IrohServer._bind_endpoint`
remembers the bound IPv4 port in `iroh-port.txt` next to the key.

Most of this runs against a fake `iroh` module (`_bind_endpoint` takes the module as an argument),
so it is offline and needs no native dep. The real-binding checks use `pytest.importorskip` and
only BIND (no relay handshake, no `online()`), like the rest of `test_iroh_server.py`.
"""

from __future__ import annotations

import asyncio
import gc
import logging
import os
import stat
import types
from pathlib import Path

import pytest

from infra.config import Settings
from infra.i18n import get_i18n
from net.iroh_server import (
    PORT_SIDECAR_NAME,
    IrohServer,
    ipv4_port,
    port_sidecar_path,
    read_remembered_port,
    write_remembered_port,
)

SECRET = b"\x01" * 32


# --- pure helpers ----------------------------------------------------------


def test_ipv4_port_reads_the_ipv4_socket_only() -> None:
    assert ipv4_port(["0.0.0.0:50264", "[::]:58702"]) == 50264
    assert ipv4_port(["[::]:58702", "0.0.0.0:50264"]) == 50264  # order does not matter
    assert ipv4_port(["[::]:58702"]) == 0  # an IPv6-only host pins nothing
    assert ipv4_port([]) == 0
    assert ipv4_port(["garbage", "0.0.0.0:", "0.0.0.0:0", "0.0.0.0:99999"]) == 0


def test_sidecar_lives_beside_the_secret_key(tmp_path) -> None:
    assert port_sidecar_path(tmp_path / "iroh-secret.key") == tmp_path / PORT_SIDECAR_NAME


def test_remembered_port_round_trips_and_is_private(tmp_path) -> None:
    sidecar = tmp_path / PORT_SIDECAR_NAME
    assert read_remembered_port(sidecar) == 0  # missing -> nothing remembered
    assert write_remembered_port(sidecar, 47321) is True
    assert read_remembered_port(sidecar) == 47321
    if os.name == "posix":
        assert stat.S_IMODE(sidecar.stat().st_mode) == 0o600


@pytest.mark.parametrize("junk", ["", "abc", "0", "-5", "70000", "12.5", "47321 47322"])
def test_damaged_sidecar_reads_as_nothing_remembered(tmp_path, junk) -> None:
    sidecar = tmp_path / PORT_SIDECAR_NAME
    sidecar.write_text(junk, encoding="utf-8")
    assert read_remembered_port(sidecar) == 0
    sidecar.write_bytes(b"\xff\xfe\x00")  # not even text
    assert read_remembered_port(sidecar) == 0


def test_unwritable_keys_dir_does_not_brick_startup(tmp_path, caplog) -> None:
    if os.name != "posix" or (hasattr(os, "geteuid") and os.geteuid() == 0):
        pytest.skip("needs POSIX perms and a non-root euid")
    ro_dir = tmp_path / "ro"
    ro_dir.mkdir()
    os.chmod(ro_dir, 0o500)
    try:
        with caplog.at_level(logging.WARNING, logger="net.iroh_server"):
            assert write_remembered_port(ro_dir / PORT_SIDECAR_NAME, 47321) is False
        assert "Could not persist the Iroh UDP port" in caplog.text
    finally:
        os.chmod(ro_dir, 0o700)


# --- port policy against a fake iroh ---------------------------------------


class _FakeEndpoint:
    def __init__(self, port: int, *, broken_sockets: bool = False) -> None:
        self.port = port
        self._broken = broken_sockets

    def bound_sockets(self) -> list[str]:
        if self._broken:
            raise RuntimeError("no sockets")
        return [f"0.0.0.0:{self.port}", "[::]:59999"]


class _FakeIroh:
    """The slice of the `iroh` module `_bind_endpoint` touches. `taken` is the set of UDP ports
    a bind to `0.0.0.0:PORT` refuses; an unpinned bind gets the next ephemeral port."""

    def __init__(self, taken: tuple[int, ...] = (), *, first_ephemeral: int = 51000, broken_sockets: bool = False):
        self.taken = set(taken)
        self.requested: list[str | None] = []  # the bind_addr of every bind attempt, in order
        self._next = first_ephemeral
        self._broken = broken_sockets
        self.Endpoint = types.SimpleNamespace(bind=self._bind)

    def preset_n0(self) -> str:
        return "n0"

    def EndpointOptions(self, **kwargs):  # noqa: N802 - mirrors the real class name
        return types.SimpleNamespace(**kwargs)

    async def _bind(self, options) -> _FakeEndpoint:
        addr = getattr(options, "bind_addr", None)
        assert options.secret_key == SECRET and isinstance(options.secret_key, bytes)
        self.requested.append(addr)
        if addr is None:
            self._next += 1
            return _FakeEndpoint(self._next, broken_sockets=self._broken)
        port = int(addr.rsplit(":", 1)[1])
        if port in self.taken:
            raise OSError("Address already in use")
        return _FakeEndpoint(port, broken_sockets=self._broken)


def _server(tmp_path: Path, *, port: int = 0) -> tuple[IrohServer, Path]:
    secret_path = tmp_path / "iroh-secret.key"
    return IrohServer(object(), secret_path=secret_path, port=port), port_sidecar_path(secret_path)


async def test_first_start_binds_random_and_remembers_what_it_got(tmp_path) -> None:
    server, sidecar = _server(tmp_path)
    fake = _FakeIroh(first_ephemeral=51000)

    endpoint = await server._bind_endpoint(fake, SECRET, server._secret_path)

    assert fake.requested == [None]  # nothing remembered -> unpinned bind
    assert endpoint.port == 51001
    assert server.direct_port == 51001
    assert server.port_changed_from == 0
    assert read_remembered_port(sidecar) == 51001


async def test_second_start_binds_the_remembered_port(tmp_path) -> None:
    first, sidecar = _server(tmp_path)
    await first._bind_endpoint(_FakeIroh(first_ephemeral=51000), SECRET, first._secret_path)
    assert read_remembered_port(sidecar) == 51001

    second, _ = _server(tmp_path)
    fake = _FakeIroh(first_ephemeral=52000)  # a fresh unpinned bind WOULD give another port
    endpoint = await second._bind_endpoint(fake, SECRET, second._secret_path)

    assert fake.requested == ["0.0.0.0:51001"]  # pinned, no random fallback attempted
    assert endpoint.port == second.direct_port == 51001
    assert second.port_changed_from == 0
    assert read_remembered_port(sidecar) == 51001


async def test_taken_port_falls_back_to_random_and_overwrites_the_sidecar(tmp_path, caplog) -> None:
    server, sidecar = _server(tmp_path)
    write_remembered_port(sidecar, 51001)
    fake = _FakeIroh(taken=(51001,), first_ephemeral=52000)

    with caplog.at_level(logging.WARNING, logger="net.iroh_server"):
        endpoint = await server._bind_endpoint(fake, SECRET, server._secret_path)

    assert fake.requested == ["0.0.0.0:51001", None]  # tried the remembered port, then a random one
    assert endpoint.port == server.direct_port == 52001
    assert server.port_changed_from == 51001
    assert read_remembered_port(sidecar) == 52001  # the new port is the remembered one from now on
    assert "ticket change" in caplog.text and "51001" in caplog.text


async def test_operator_override_beats_the_sidecar_and_is_saved(tmp_path) -> None:
    server, sidecar = _server(tmp_path, port=41000)
    write_remembered_port(sidecar, 51001)
    fake = _FakeIroh()

    endpoint = await server._bind_endpoint(fake, SECRET, server._secret_path)

    assert fake.requested == ["0.0.0.0:41000"]
    assert endpoint.port == server.direct_port == 41000
    assert read_remembered_port(sidecar) == 41000  # dropping the override later keeps this port


async def test_taken_override_still_starts_and_says_so(tmp_path, caplog) -> None:
    """Availability beats pinning: a pinned port someone else holds must not keep the table down."""
    server, sidecar = _server(tmp_path, port=41000)
    fake = _FakeIroh(taken=(41000,), first_ephemeral=52000)

    with caplog.at_level(logging.WARNING, logger="net.iroh_server"):
        await server._bind_endpoint(fake, SECRET, server._secret_path)

    assert fake.requested == ["0.0.0.0:41000", None]
    assert server.port_changed_from == 41000
    assert read_remembered_port(sidecar) == server.direct_port == 52001
    assert "pinned UDP port 41000" in caplog.text


@pytest.mark.parametrize("bad", [-1, 65536, 99999])
async def test_invalid_override_is_ignored_with_a_warning(tmp_path, caplog, bad) -> None:
    server, sidecar = _server(tmp_path, port=bad)
    write_remembered_port(sidecar, 51001)
    fake = _FakeIroh()

    with caplog.at_level(logging.WARNING, logger="net.iroh_server"):
        await server._bind_endpoint(fake, SECRET, server._secret_path)

    assert fake.requested == ["0.0.0.0:51001"]  # the sidecar still applies
    assert "TRPG_TUI__IROH_PORT" in caplog.text


async def test_unreadable_sockets_never_fail_startup_or_write_a_bogus_sidecar(tmp_path) -> None:
    server, sidecar = _server(tmp_path)

    endpoint = await server._bind_endpoint(_FakeIroh(broken_sockets=True), SECRET, server._secret_path)

    assert endpoint is not None
    assert server.direct_port == 0
    assert not sidecar.exists()


async def test_bind_failure_that_is_not_the_port_still_surfaces(tmp_path) -> None:
    """The fallback is for a wanted port only; if even the unpinned bind fails, the caller sees it."""

    class _AlwaysFails(_FakeIroh):
        async def _bind(self, options):
            raise OSError("no network stack")

    server, sidecar = _server(tmp_path)
    write_remembered_port(sidecar, 51001)
    with pytest.raises(OSError, match="no network stack"):
        await server._bind_endpoint(_AlwaysFails(), SECRET, server._secret_path)
    assert read_remembered_port(sidecar) == 51001  # a failed start does not clobber the memory


# --- start(): the secret-path switch ---------------------------------------


def _patch_real_iroh_bind(monkeypatch, bound: list[object]):
    """Replace the real `Endpoint.bind` with a recorder (no network). Returns the `iroh` module."""
    iroh = pytest.importorskip("iroh")

    class _Endpoint:
        def __init__(self, port: int) -> None:
            self.port = port

        async def online(self) -> None:
            return None

        def addr(self):
            return None

        def bound_sockets(self) -> list[str]:
            return [f"0.0.0.0:{self.port}", "[::]:1"]

    async def _fake_bind(_cls, options):
        bound.append(options)
        pinned = options.bind_addr
        return _Endpoint(int(pinned.rsplit(":", 1)[1]) if pinned else 53000 + len(bound))

    monkeypatch.setattr(iroh.Endpoint, "bind", classmethod(_fake_bind))
    monkeypatch.setattr(iroh.EndpointTicket, "from_addr", classmethod(lambda _cls, _addr: "ticket-fake"))
    return iroh


async def test_start_with_a_secret_reuses_its_port_on_the_next_start(monkeypatch, tmp_path) -> None:
    bound: list[object] = []
    _patch_real_iroh_bind(monkeypatch, bound)
    secret_path = tmp_path / "iroh-secret.key"

    first = IrohServer(object(), secret_path=secret_path)
    await first.start()
    second = IrohServer(object(), secret_path=secret_path)
    await second.start()

    assert bound[0].bind_addr is None  # first start: random
    assert bound[1].bind_addr == f"0.0.0.0:{first.direct_port}"  # second start: the same port
    assert second.direct_port == first.direct_port


async def test_start_without_a_secret_binds_as_before_and_leaves_no_sidecar(monkeypatch, tmp_path) -> None:
    """Loopback/tests: no persisted identity, so no persisted port either -- even with an override."""
    bound: list[object] = []
    _patch_real_iroh_bind(monkeypatch, bound)
    monkeypatch.chdir(tmp_path)

    server = IrohServer(object(), port=41000)
    await server.start()

    assert bound[0].bind_addr is None
    assert server.direct_port == 0
    assert list(tmp_path.iterdir()) == []


# --- the real binding (bind only; no relay handshake) ----------------------


def _free_udp_port() -> int:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("0.0.0.0", 0))
        return sock.getsockname()[1]


async def _poll_direct_ports(iroh, endpoint) -> set[int]:
    """The ports inside the ticket's direct addresses (they fill in just after bind)."""
    for _ in range(40):
        ticket = str(iroh.EndpointTicket.from_addr(endpoint.addr()))
        addrs = iroh.EndpointTicket.from_string(ticket).endpoint_addr().direct_addresses()
        v4 = {int(a.rsplit(":", 1)[1]) for a in addrs if not a.startswith("[")}
        if v4:
            return v4
        await asyncio.sleep(0.1)
    return set()


async def test_real_binding_keeps_the_ticket_port_across_two_starts(tmp_path) -> None:
    iroh = pytest.importorskip("iroh")
    from net.iroh_server import load_or_create_secret

    secret_path = tmp_path / "iroh-secret.key"
    secret = load_or_create_secret(secret_path).to_bytes()

    first = IrohServer(object(), secret_path=secret_path)
    try:
        first._endpoint = await first._bind_endpoint(iroh, secret, secret_path)
    except Exception as exc:  # a sandbox with no UDP socket support is not what this test is about
        pytest.skip(f"cannot bind an iroh endpoint here: {exc!r}")
    ports_first = await _poll_direct_ports(iroh, first._endpoint)
    assert first.direct_port and ports_first == {first.direct_port}
    assert read_remembered_port(port_sidecar_path(secret_path)) == first.direct_port
    pinned = first.direct_port

    # `close()` stops the endpoint but the OS only frees the UDP port once the handle is
    # dropped (defensive-patterns #8 territory), so release it like a process exit would.
    await first.close()
    del first
    gc.collect()

    second = IrohServer(object(), secret_path=secret_path)
    second._endpoint = await second._bind_endpoint(iroh, secret, secret_path)
    try:
        assert second.direct_port == pinned
        assert second.port_changed_from == 0
        assert await _poll_direct_ports(iroh, second._endpoint) == {pinned}
    finally:
        await second.close()


async def test_real_binding_falls_back_when_the_remembered_port_is_taken(tmp_path) -> None:
    iroh = pytest.importorskip("iroh")
    import socket

    from net.iroh_server import load_or_create_secret

    secret_path = tmp_path / "iroh-secret.key"
    secret = load_or_create_secret(secret_path).to_bytes()
    squatter = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    squatter.bind(("0.0.0.0", 0))
    taken = squatter.getsockname()[1]
    write_remembered_port(port_sidecar_path(secret_path), taken)

    server = IrohServer(object(), secret_path=secret_path)
    try:
        server._endpoint = await server._bind_endpoint(iroh, secret, secret_path)
    except Exception as exc:
        squatter.close()
        pytest.skip(f"cannot bind an iroh endpoint here: {exc!r}")
    try:
        assert server.port_changed_from == taken
        assert server.direct_port and server.direct_port != taken
        assert read_remembered_port(port_sidecar_path(secret_path)) == server.direct_port
    finally:
        squatter.close()
        await server.close()


# --- operator surface: config + banner -------------------------------------


def test_iroh_port_setting_defaults_to_auto_and_reads_the_env(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("TRPG_TUI__IROH_PORT", raising=False)
    assert Settings(_env_file=str(tmp_path / "none.env")).tui.iroh_port == 0
    monkeypatch.setenv("TRPG_TUI__IROH_PORT", "47321")
    assert Settings(_env_file=str(tmp_path / "none.env")).tui.iroh_port == 47321


@pytest.mark.parametrize("lang", ["en", "zh"])
def test_banner_names_the_port_and_flags_a_changed_one(capsys, tmp_path, lang) -> None:
    import app as app_module

    i18n = get_i18n(lang)
    keys = str(tmp_path / "keys.toml")

    app_module._announce_iroh_ticket(i18n, "endpointabc", keys)  # nothing pinned (e.g. IPv6-only host)
    bare = capsys.readouterr().err.splitlines()
    assert not any("TRPG_TUI__IROH_PORT" in line for line in bare)

    app_module._announce_iroh_ticket(i18n, "endpointabc", keys, port=47321)
    steady = capsys.readouterr().err.splitlines()
    assert len(steady) == len(bare) + 1  # one extra line: the port, for a firewall rule
    assert "47321" in steady[-1] and "TRPG_TUI__IROH_PORT" in steady[-1]

    app_module._announce_iroh_ticket(i18n, "endpointabc", keys, port=47322, port_changed_from=47321)
    changed = capsys.readouterr().err.splitlines()
    assert len(changed) == len(steady) + 1  # plus the "your saved tickets are stale" warning
    assert "47321" in changed[-1] and "47322" in changed[-1]
