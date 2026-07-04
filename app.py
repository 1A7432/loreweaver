"""Application entrypoint for loreweaver."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from adapters.cli.adapter import CliAdapter
from adapters.cli.demo import demo_kp_responder
from agent.kp_tools import build_kp_toolset
from agent.services import build_services
from core import skills as core_skills
from core.dice_engine import seed_dice
from gateway.commands import CommandRouter
from gateway.hub import RoomHub
from gateway.registry import platform_registry
from gateway.runner import GatewayRunner
from infra.config import Settings
from infra.embeddings import FakeEmbeddings, LocalEmbeddings
from infra.i18n import I18n, get_i18n
from infra.llm import FakeLLM
from net.keystore import Keystore
from net.tui_server import TuiServer

DEFAULT_TUI_HOST = "127.0.0.1"
DEFAULT_TUI_PORT = 8787
DEFAULT_TUI_KEYS_PATH = "keys.toml"


def _app_services(settings, *, llm=None, embeddings=None):
    """Shared CLI/TUI/serve wiring: a FILE-backed store so campaign progress
    auto-saves and restores across restarts, and a LOCAL hash embedder by default
    so document/vector features work with any chat-only provider (configure a
    dedicated embeddings provider for higher-quality retrieval)."""
    if not settings.llm.api_key:
        llm = llm or FakeLLM(responder=demo_kp_responder)
    embeddings = embeddings or LocalEmbeddings(64)
    db = settings.db_path or os.path.join(settings.data_dir, "loreweaver.db")
    os.makedirs(os.path.dirname(db) or ".", exist_ok=True)
    # Layer B.3a (`docs/plugins.md` "Layer B"): a user data-dir `skills/` directory so
    # `agent.forge`-generated skills are discoverable alongside the built-ins, without ever
    # touching the checkout. Set once here (the one place every entrypoint below funnels
    # through) rather than importing anything heavier than `core.skills` into `app.py`.
    core_skills._USER_SKILL_DIR = Path(settings.data_dir) / "skills"
    return build_services(settings, llm=llm, embeddings=embeddings, db_path=db)


def build_runner(settings: Settings, *, llm=None, embeddings=None) -> GatewayRunner:
    if not settings.llm.api_key:
        llm = llm or FakeLLM(responder=demo_kp_responder)
        embeddings = embeddings or FakeEmbeddings(64)
    services = _app_services(settings, llm=llm, embeddings=embeddings)
    adapter = CliAdapter()
    return GatewayRunner(
        services,
        adapters=[adapter],
        command_router=CommandRouter(services),
        toolset=build_kp_toolset(services),
    )


def build_tui_server(settings: Settings, keystore: Keystore, *, host: str, port: int, llm=None, embeddings=None) -> TuiServer:
    """Wire a `TuiServer` the same way `build_runner` wires the CLI gateway
    (offline `FakeLLM` demo when no API key is configured)."""
    if not settings.llm.api_key:
        llm = llm or FakeLLM(responder=demo_kp_responder)
        embeddings = embeddings or FakeEmbeddings(64)
    services = _app_services(settings, llm=llm, embeddings=embeddings)
    return TuiServer(
        services,
        keystore,
        host=host,
        port=port,
        command_router=CommandRouter(services),
        toolset=build_kp_toolset(services),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cli", action="store_true")
    parser.add_argument("--platforms")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--host", default=DEFAULT_TUI_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_TUI_PORT)
    parser.add_argument("--keys", default=os.environ.get("TRPG_TUI_KEYS", DEFAULT_TUI_KEYS_PATH))
    parser.add_argument("--tui-key", dest="tui_key_cmd", choices=["add"])
    parser.add_argument("--room")
    parser.add_argument("--name")
    parser.add_argument("--role", choices=("player", "keeper"), default="player")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--exec", dest="exec_cmd")
    mode.add_argument("--script")
    args = parser.parse_args(argv)

    settings = Settings()
    i18n = get_i18n(settings.locale)

    if args.tui_key_cmd == "add":
        return _tui_key_add(i18n, args)

    if args.serve:
        return _run_serve(settings, i18n, args)

    if args.platforms and not args.cli:
        print(i18n.t("cli.platforms_stub", platforms=args.platforms), file=sys.stderr)
        return 0

    if not args.cli:
        print(i18n.t("cli.no_mode"), file=sys.stderr)
        return 0

    offline = not settings.llm.api_key
    if offline:
        print(i18n.t("cli.offline_demo_notice"), file=sys.stderr)

    runner = build_runner(settings)
    seed_dice(0)

    try:
        return asyncio.run(_run_cli(runner, exec_cmd=args.exec_cmd, script=args.script))
    finally:
        runner.services.store.close()


async def _run_cli(runner: GatewayRunner, *, exec_cmd: str | None, script: str | None) -> int:
    adapter = _cli_adapter(runner)
    await runner.start()
    try:
        if exec_cmd is not None:
            await adapter.handle_inbound(adapter.inbound(exec_cmd, message_id="cli-exec"))
            return 0

        if script is not None:
            path = Path(script)
            if not path.exists():
                print(runner.services.i18n.t("cli.script_missing", path=script), file=sys.stderr)
                return 2
            lines = path.read_text(encoding="utf-8").splitlines()
            for index, line in enumerate(lines, 1):
                if not line.strip():
                    continue
                await adapter.handle_inbound(adapter.inbound(line, message_id=f"cli-script-{index}"))
            return 0

        for index, raw in enumerate(sys.stdin, 1):
            line = raw.rstrip("\n")
            if not line.strip():
                continue
            await adapter.handle_inbound(adapter.inbound(line, message_id=f"cli-stdin-{index}"))
        return 0
    finally:
        await runner.stop()


def _cli_adapter(runner: GatewayRunner) -> CliAdapter:
    for adapter in runner.adapters:
        if isinstance(adapter, CliAdapter):
            return adapter
    raise RuntimeError(runner.services.i18n.t("cli.adapter_missing"))


def _tui_key_add(i18n: I18n, args: argparse.Namespace) -> int:
    """`--tui-key add --room R --name N [--role player|keeper]`: mint + persist a key."""
    if not args.room:
        print(i18n.t("tui.key.room_required"), file=sys.stderr)
        return 2

    keystore = Keystore.load(args.keys)
    key = keystore.add(room=args.room, name=args.name or "", role=args.role)
    keystore.save(args.keys)
    print(i18n.t("tui.key.added", key=key, room=args.room, name=args.name or "-", role=args.role))
    return 0


def _bootstrap_keystore(keystore: Keystore, i18n: I18n, keys_path: str) -> None:
    """First run: if the keystore has no keys, mint ONE keeper key so the operator gets admin
    access with zero CLI, and surface it (a stderr banner + a `keeper-key.txt` sidecar next to
    the keystore). Idempotent — a no-op once any key exists. Room via TRPG_BOOTSTRAP_ROOM."""
    if not keystore.is_empty():
        return
    room = os.environ.get("TRPG_BOOTSTRAP_ROOM", "table")
    key = keystore.add(room=room, name="keeper", role="keeper")
    keystore.save(keys_path)
    sidecar = Path(keys_path).with_name("keeper-key.txt")
    try:
        sidecar.write_text(f"room={room}\nrole=keeper\nkey={key}\n", encoding="utf-8")  # i18n-exempt: data file
    except OSError:
        pass
    print(i18n.t("tui.serve.bootstrap.banner", room=room), file=sys.stderr)
    print(i18n.t("tui.serve.bootstrap.key", key=key), file=sys.stderr)
    print(i18n.t("tui.serve.bootstrap.hint", path=str(sidecar)), file=sys.stderr)


def _run_serve(settings: Settings, i18n: I18n, args: argparse.Namespace) -> int:
    """`--serve [--keys FILE]`: run the networked TUI server over the Iroh p2p transport — it
    prints a shareable ticket (no domain/TLS/port-forward). WebSocket is not a serve option; it
    lives on only as the offline test / loopback carrier (tests instantiate `TuiServer` directly).

    With `--platforms a,b` the server runs in COMBINED mode: one `RoomHub`/`Services` shared by the
    TUI server AND a `GatewayRunner` driving the (experimental, roadmap-only) chat adapters.
    """
    if not settings.llm.api_key:
        print(i18n.t("cli.offline_demo_notice"), file=sys.stderr)

    if args.platforms:
        return _run_serve_combined(settings, i18n, args)

    keystore = Keystore.load(args.keys)
    _bootstrap_keystore(keystore, i18n, args.keys)
    server = build_tui_server(settings, keystore, host=args.host, port=args.port)
    seed_dice(0)

    # A clean shutdown (Ctrl-C, or the listener stopping) exits 0; a startup failure exits non-zero
    # so systemd's `Restart=on-failure` fires and scripts/automation don't read "no ticket" as success.
    started = False
    try:
        started = asyncio.run(_serve_iroh(server, i18n, args.keys))
    except KeyboardInterrupt:
        started = True
    finally:
        server.services.store.close()
    return 0 if started else 1


async def _serve_iroh(core: TuiServer, i18n: I18n, keys_path: str) -> bool:
    """Run the Iroh p2p listener — the one carrier `--serve` starts. Share a ticket; no domain,
    TLS or port-forward. (WebSocket lives on ONLY as the offline test / loopback transport,
    instantiated directly in tests.) `core` is a `net.session.SessionCore` — a `TuiServer` is one,
    so we borrow it as the shared engine without ever binding its socket.

    Returns True once the endpoint came online and served (a clean stop), False if it never
    started — the caller turns a False into a non-zero exit code so a supervisor restarts it."""
    from net.iroh_server import IrohServer

    iroh_server = IrohServer(core)
    try:
        # Bound the relay handshake so an unreachable relay can't hang startup forever.
        ticket = await asyncio.wait_for(iroh_server.start(), timeout=45)
    except ImportError:
        print(i18n.t("tui.serve.iroh.missing"), file=sys.stderr)
        return False
    except Exception as exc:  # relay unreachable, bind failure, startup timeout, etc.
        print(i18n.t("tui.serve.iroh.failed", error=str(exc)), file=sys.stderr)
        return False
    _announce_iroh_ticket(i18n, ticket, keys_path)
    try:
        await iroh_server.serve()
    finally:
        await iroh_server.close()
    return True


def _announce_iroh_ticket(i18n: I18n, ticket: str, keys_path: str) -> None:
    """Print the shareable Iroh ticket prominently + drop it in a sidecar file, mirroring the
    keeper-key bootstrap banner. The operator shares this ticket (the address) + an invite key."""
    sidecar = Path(keys_path).with_name("iroh-ticket.txt")
    try:
        sidecar.write_text(f"ticket={ticket}\n", encoding="utf-8")  # i18n-exempt: data file
    except OSError:
        pass
    print(i18n.t("tui.serve.iroh.banner"), file=sys.stderr)
    print(i18n.t("tui.serve.iroh.ticket", ticket=ticket), file=sys.stderr)
    print(i18n.t("tui.serve.iroh.hint", path=str(sidecar)), file=sys.stderr)


# --- combined `--serve --platforms` mode (M7) -----------------------------

# Per-platform config keys -> the `TRPG_*` env vars they read (see `.env.example`).
_PLATFORM_ENV = {
    "qq": {"app_id": "TRPG_QQ__APP_ID", "secret": "TRPG_QQ__SECRET", "token": "TRPG_QQ__TOKEN"},
    "telegram": {"token": "TRPG_TELEGRAM__TOKEN"},
    "discord": {"token": "TRPG_DISCORD__TOKEN", "app_id": "TRPG_DISCORD__APP_ID"},
    "feishu": {"app_id": "TRPG_FEISHU__APP_ID", "app_secret": "TRPG_FEISHU__APP_SECRET"},
}
# The config keys that MUST be present or the platform is skipped.
_PLATFORM_REQUIRED = {
    "qq": ("app_id", "secret"),
    "telegram": ("token",),
    "discord": ("token",),
    "feishu": ("app_id", "app_secret"),
}


def _run_serve_combined(settings: Settings, i18n: I18n, args: argparse.Namespace) -> int:
    services = _serve_services(settings)
    keystore = Keystore.load(args.keys)
    _bootstrap_keystore(keystore, i18n, args.keys)
    hub = RoomHub()
    command_router = CommandRouter(services, keystore=keystore, hub=hub)
    toolset = build_kp_toolset(services)

    server = TuiServer(
        services,
        keystore,
        host=args.host,
        port=args.port,
        command_router=command_router,
        toolset=toolset,
        hub=hub,
    )
    adapters = _build_platform_adapters(args.platforms, i18n)
    runner = GatewayRunner(
        services,
        adapters,
        command_router=command_router,
        toolset=toolset,
        hub=hub,
        keystore=keystore,
    )

    seed_dice(0)
    print(
        i18n.t("cli.combined_listening", host=args.host, port=args.port, platforms=args.platforms),
        file=sys.stderr,
    )
    try:
        asyncio.run(_serve_combined(server, runner))
    except KeyboardInterrupt:
        pass
    finally:
        services.store.close()
    return 0


async def _serve_combined(server: TuiServer, runner: GatewayRunner) -> None:
    """Connect the chat adapters, then serve the TUI until stopped."""
    await runner.start()
    try:
        await server.serve()
    finally:
        await runner.stop()
        await server.close()


def _serve_services(settings: Settings, *, llm=None, embeddings=None):
    """Build one `Services` graph (offline `FakeLLM` demo when no API key)."""
    if not settings.llm.api_key:
        llm = llm or FakeLLM(responder=demo_kp_responder)
        embeddings = embeddings or FakeEmbeddings(64)
    return _app_services(settings, llm=llm, embeddings=embeddings)


def _build_platform_adapters(platforms: str, i18n: I18n) -> list:
    """Instantiate the requested chat adapters; skip any with missing creds."""
    _register_platform_adapters()
    adapters = []
    for name in _split_platforms(platforms):
        entry = platform_registry.get(name)
        if entry is None:
            print(i18n.t("cli.platform_unknown", platform=name), file=sys.stderr)
            continue
        config = _platform_config(name)
        if config is None:
            print(i18n.t("cli.platform_skip_no_creds", platform=name), file=sys.stderr)
            continue
        adapter = platform_registry.create_adapter(name, config)
        if adapter is None:
            print(i18n.t("cli.platform_skip_no_creds", platform=name), file=sys.stderr)
            continue
        adapters.append(adapter)
    return adapters


def _split_platforms(platforms: str) -> list[str]:
    seen: list[str] = []
    for raw in (platforms or "").split(","):
        name = raw.strip().casefold()
        if name and name not in seen:
            seen.append(name)
    return seen


def _platform_config(name: str) -> dict[str, str] | None:
    env_map = _PLATFORM_ENV.get(name)
    if env_map is None:
        return None
    config = {key: value for key, env in env_map.items() if (value := os.environ.get(env, ""))}
    if any(key not in config for key in _PLATFORM_REQUIRED.get(name, ())):
        return None
    return config


def _register_platform_adapters() -> None:
    """Import adapter modules so they register on the platform registry."""
    import adapters.discord  # noqa: F401
    import adapters.feishu  # noqa: F401
    import adapters.qq_official  # noqa: F401
    from adapters.telegram import adapter as telegram_adapter

    telegram_adapter.register()


if __name__ == "__main__":
    raise SystemExit(main())
