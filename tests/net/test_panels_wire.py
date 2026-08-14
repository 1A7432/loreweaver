"""End-to-end wire tests for M15 module UI panels (protocol v1.8) over the offline
WebSocket carrier: per-viewer `ui_manifest` audience filtering (the red line: a keeper
panel NEVER enters a player's manifest), `.panels enable` manifest pushes, `panel_intent`
routing through the real command/dice engine, and pack-asset resolution on the media
byte channel — enabled packs only."""

from __future__ import annotations

import json
from pathlib import Path

import websockets

from agent.services import build_services
from core.pack import MANIFEST_NAME, build_pack, install_pack
from gateway.ops import set_enabled_panel_packs
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from net.keystore import Keystore
from net.session import PROTOCOL_VERSION
from net.tui_server import TuiServer, _pack_media_message, _unpack_media_message
from tests.net.test_tui_server import _connect_and_join, _join, _recv, _recv_until, _start

PANELS_YAML = """\
panels:
  - id: board
    title: {en: Case Board, zh: 案情板}
    slot: sidebar
    audience: all
    blocks:
      - {kind: meter, label: {en: Fear}, value: {$var: town_fear}, min: 0, max: 10}
  - id: secrets
    title: {en: Keeper Secrets}
    slot: sidebar
    audience: keeper
    blocks:
      - {kind: text, text: {en: The butler did it.}}
  - id: sheet
    title: {en: Player Sheet}
    slot: tray
    audience: player
    blocks:
      - {kind: stat, label: {en: Luck}, value: {$var: luck}}
  - id: map
    title: {en: Manor Map}
    slot: modal
    audience: all
    entry: ui/map/index.html
    assets: [ui/map/index.html, ui/map/app.js]
    fallback: null
"""

APP_JS = b"console.log('manor')"


def _install_panel_pack(tmp_path: Path):
    """Build + install a real pack (the full pipeline) into tmp data_dir; return the built pack."""
    src = tmp_path / "panelpack-src"
    (src / "ui/map").mkdir(parents=True)
    (src / "ui/panels.yaml").write_text(PANELS_YAML, encoding="utf-8")
    (src / "ui/map/index.html").write_text("<main>map</main>", encoding="utf-8")
    (src / "ui/map/app.js").write_bytes(APP_JS)
    (src / MANIFEST_NAME).write_text(
        "id: panelpack\nversion: 1.0.0\nname: Panels\ndescription: test\nauthors: [ada]\n"
        "license: MIT\nengine: {}\ncontents:\n  panels: [ui/panels.yaml]\n",
        encoding="utf-8",
    )
    built = build_pack(src, tmp_path / "panelpack.lwpack")
    install_pack(
        built.path,
        packs_dir=tmp_path / "data/packs",
        skills_dir=tmp_path / "data/skills",
        rulepacks_dir=tmp_path / "data/rulepacks",
        presets_dir=tmp_path / "data/presets",
        current_protocol=PROTOCOL_VERSION,
        current_server="1.0.0",
    )
    return built


def _panel_services(tmp_path: Path):
    return build_services(
        Settings(locale="en", data_dir=str(tmp_path / "data")),
        llm=FakeLLM(script=[]),
        embeddings=FakeEmbeddings(64),
    )


def _chat_key(room: str) -> str:
    return SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()


async def test_manifest_audience_filter_is_per_viewer_and_keeper_panels_never_reach_players(tmp_path):
    _install_panel_pack(tmp_path)
    services = _panel_services(tmp_path)
    await set_enabled_panel_packs(services.store, _chat_key("demo"), ["panelpack"])

    keystore = Keystore()
    player_key = keystore.add(room="demo", name="Pat", role="player")
    keeper_key = keystore.add(room="demo", name="Kay", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws_player = await websockets.connect(url)
        await _join(ws_player, player_key)
        player_manifest = await _recv_until(ws_player, "ui_manifest")
        ws_keeper = await websockets.connect(url)
        await _join(ws_keeper, keeper_key)
        keeper_manifest = await _recv_until(ws_keeper, "ui_manifest")

        player_ids = {panel["id"] for panel in player_manifest["panels"]}
        keeper_ids = {panel["id"] for panel in keeper_manifest["panels"]}
        # RED LINE: the keeper-audience panel is structurally absent from the player's
        # manifest (and `audience` itself never rides the wire).
        assert player_ids == {"panelpack/board", "panelpack/sheet", "panelpack/map"}
        assert keeper_ids == {"panelpack/board", "panelpack/secrets", "panelpack/map"}
        assert all("audience" not in panel for panel in player_manifest["panels"])

        by_id = {panel["id"]: panel for panel in player_manifest["panels"]}
        tier2 = by_id["panelpack/map"]
        assert tier2["tier"] == 2 and tier2["fallback"] is None
        assert len(tier2["entry"]["hash"]) == 64
        assert [asset["path"] for asset in tier2["assets"]] == ["app.js"]

        await ws_player.close()
        await ws_keeper.close()
    finally:
        await server.close()


async def test_panels_enable_command_pushes_fresh_per_viewer_manifests(tmp_path):
    _install_panel_pack(tmp_path)
    services = _panel_services(tmp_path)
    keystore = Keystore()
    player_key = keystore.add(room="demo", name="Pat", role="player")
    keeper_key = keystore.add(room="demo", name="Kay", role="keeper")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws_player, *_ = await _connect_and_join(url, player_key, "Pat")
        ws_keeper, *_ = await _connect_and_join(url, keeper_key, "Kay")
        # Drain the presence frame Pat receives when Kay joins.
        await _recv_until(ws_player, "presence")

        await ws_keeper.send(json.dumps({"type": "input", "text": ".panels enable panelpack"}))
        pushed_keeper = await _recv_until(ws_keeper, "ui_manifest")
        pushed_player = await _recv_until(ws_player, "ui_manifest")
        assert {panel["id"] for panel in pushed_keeper["panels"]} >= {"panelpack/secrets"}
        assert "panelpack/secrets" not in {panel["id"] for panel in pushed_player["panels"]}

        await ws_player.close()
        await ws_keeper.close()
    finally:
        await server.close()


async def test_panel_intent_routes_as_the_player_through_the_real_dice_engine(tmp_path):
    _install_panel_pack(tmp_path)
    services = _panel_services(tmp_path)
    await set_enabled_panel_packs(services.store, _chat_key("demo"), ["panelpack"])
    keystore = Keystore()
    key = keystore.add(room="demo", name="Pat", role="player")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Pat")
        # kind=roll -> a public `.r <expr>` as the player; the dice engine rolls it.
        await ws.send(
            json.dumps({"type": "panel_intent", "panel": "panelpack/board", "kind": "roll", "value": "1d1+1"})
        )
        dice = await _recv_until(ws, "dice")
        assert dice["total"] == 2
        # kind=input -> exactly as if the player typed the value (here: a dot command).
        await ws.send(
            json.dumps({"type": "panel_intent", "panel": "panelpack/board", "kind": "input", "value": ".r 1d1"})
        )
        dice = await _recv_until(ws, "dice")
        assert dice["total"] == 1
        await ws.close()
    finally:
        await server.close()


async def test_panel_intent_outside_the_members_manifest_is_forbidden(tmp_path):
    _install_panel_pack(tmp_path)
    services = _panel_services(tmp_path)
    await set_enabled_panel_packs(services.store, _chat_key("demo"), ["panelpack"])
    keystore = Keystore()
    key = keystore.add(room="demo", name="Pat", role="player")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Pat")
        # RED LINE: a player intent against the keeper-audience panel is refused before
        # any routing — the panel is simply not in this member's manifest.
        await ws.send(
            json.dumps({"type": "panel_intent", "panel": "panelpack/secrets", "kind": "roll", "value": "1d1"})
        )
        error = await _recv(ws)
        assert (error["type"], error["code"]) == ("error", "forbidden")
        # An unknown panel id is refused the same way; nothing was rolled or echoed.
        await ws.send(
            json.dumps({"type": "panel_intent", "panel": "ghost/panel", "kind": "input", "value": "hi"})
        )
        error = await _recv(ws)
        assert (error["type"], error["code"]) == ("error", "forbidden")
        await ws.send(json.dumps({"type": "ping", "t": 7}))
        assert (await _recv(ws))["type"] == "pong"
        await ws.close()
    finally:
        await server.close()


async def test_media_get_serves_pack_assets_for_enabled_packs_only(tmp_path):
    built = _install_panel_pack(tmp_path)
    app_js_hash = next(asset.sha256 for asset in built.manifest.assets if asset.path == "ui/map/app.js")
    services = _panel_services(tmp_path)
    keystore = Keystore()
    key = keystore.add(room="demo", name="Pat", role="player")
    server = TuiServer(services, keystore, port=0)
    url = await _start(server)
    try:
        ws, *_ = await _connect_and_join(url, key, "Pat")
        # Not enabled in this room yet -> the hash resolves to nothing (no blob oracle).
        await ws.send(_pack_media_message({"op": "get", "hash": app_js_hash}))
        refused = await _recv(ws)
        assert refused["type"] == "error"

        await set_enabled_panel_packs(services.store, _chat_key("demo"), ["panelpack"])
        await ws.send(_pack_media_message({"op": "get", "hash": app_js_hash}))
        raw = await ws.recv()
        header, body = _unpack_media_message(raw)
        assert header["hash"] == app_js_hash
        assert header["mime"] == "text/javascript"
        assert body == APP_JS
        await ws.close()
    finally:
        await server.close()
