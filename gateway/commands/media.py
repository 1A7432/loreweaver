"""Audio and avatars: `.audio` / `.bgm` / `.ambience` / `.sfx` and `.avatar`, with their parsers."""

from __future__ import annotations

import shlex
from typing import Any

from agent import npc as npc_records
from gateway.audio import add_audio_item, build_audio_control, list_audio_items, resolve_audio_item, update_audio_item
from gateway.avatar import AvatarError, set_target_avatar, set_user_avatar
from gateway.commands.rooms import _is_keeper
from gateway.commands.types import CommandCtx
from gateway.hub import Event
from gateway.imagegen import allow_imagegen_request, image_name
from gateway.media import media_frame, publish_media
from gateway.ops import (
    is_media_enabled,
)
from gateway.turn import publish_state
from infra.imagegen import ImageGenError
from infra.media_store import ALLOWED_AUDIO_MIMES, ALLOWED_IMAGE_MIMES, MediaError, MediaStore

# `.audio` / `.bgm` / `.ambience` / `.sfx` subcommand vocabularies.
_AUDIO_LIST_WORDS = {"", "list", "ls", "show", "列表", "查看"}
_AUDIO_SET_WORDS = {"set", "meta", "metadata", "设置", "設置", "元数据", "元資料"}
_AUDIO_IMPORT_WORDS = {"import", "load", "导入", "導入"}
_AUDIO_PLAY_WORDS = {"play", "start", "播放", "开始", "開始"}
_AUDIO_STOP_WORDS = {"stop", "停止"}
_AUDIO_PAUSE_WORDS = {"pause", "暂停", "暫停"}
_AUDIO_RESUME_WORDS = {"resume", "继续", "繼續"}
_AUDIO_VOLUME_WORDS = {"volume", "vol", "音量"}
_AVATAR_GEN_WORDS = {"gen", "generate", "生成"}
_AVATAR_CLEAR_WORDS = {"clear", "remove", "rm", "清除", "删除", "刪除"}


def _shell_words(text: str) -> list[str]:
    try:
        return shlex.split(text)
    except ValueError:
        return text.split()


async def _resolve_avatar_target(ctx: CommandCtx, target: str) -> Any | None:
    try:
        return await npc_records.get_npc(ctx.services.documents, ctx.chat_key, target)
    except Exception:
        return None


def _split_audio_metadata(tokens: list[str]) -> tuple[str, dict[str, Any]]:
    query_tokens: list[str] = []
    metadata: dict[str, Any] = {}
    seen_metadata = False
    for token in tokens:
        key, sep, value = token.partition("=")
        normalized = key.casefold().replace("-", "_")
        if sep and normalized in {"title", "license", "source", "tags"}:
            seen_metadata = True
            if normalized == "tags":
                metadata[normalized] = [item.strip() for item in value.split(",")]
            else:
                metadata[normalized] = value.strip()
        elif seen_metadata:
            continue
        else:
            query_tokens.append(token)
    return " ".join(query_tokens).strip(), metadata


def _split_audio_play(tokens: list[str], *, default_loop: bool) -> tuple[str, dict[str, Any]]:
    query_tokens: list[str] = []
    options: dict[str, Any] = {"loop": default_loop}
    index = 0
    while index < len(tokens):
        token = tokens[index]
        lowered = token.casefold()
        if lowered in {"--loop", "loop"}:
            options["loop"] = True
            index += 1
            continue
        if lowered in {"--no-loop", "noloop", "once"}:
            options["loop"] = False
            index += 1
            continue
        if lowered in {"--volume", "volume", "vol"}:
            if index + 1 < len(tokens):
                volume = _parse_audio_volume([tokens[index + 1]])
                if volume is not None:
                    options["volume"] = volume
            index += 2
            continue
        if lowered.startswith("--volume=") or lowered.startswith("volume=") or lowered.startswith("vol="):
            volume = _parse_audio_volume([token.split("=", 1)[1]])
            if volume is not None:
                options["volume"] = volume
            index += 1
            continue
        if lowered in {"--fade", "fade", "fade_ms"}:
            if index + 1 < len(tokens):
                options["fade_ms"] = _parse_int(tokens[index + 1], default=0)
            index += 2
            continue
        if lowered.startswith("--fade=") or lowered.startswith("fade=") or lowered.startswith("fade_ms="):
            options["fade_ms"] = _parse_int(token.split("=", 1)[1], default=0)
            index += 1
            continue
        query_tokens.append(token)
        index += 1
    return " ".join(query_tokens).strip(), options


def _parse_audio_volume(tokens: list[str]) -> float | None:
    if not tokens:
        return None
    token = str(tokens[0]).strip().rstrip("%")
    try:
        value = float(token)
    except ValueError:
        return None
    if value > 1:
        value = value / 100.0
    return max(0.0, min(1.0, value))


def _parse_int(value: Any, *, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _audio_item_label(item: dict[str, Any]) -> str:
    title = str(item.get("title") or "").strip()
    name = str(item.get("name") or item.get("hash") or "").strip()
    return title or name or str(item.get("hash", ""))[:12]


def _audio_item_line(item: dict[str, Any]) -> str:
    label = _audio_item_label(item)
    short_hash = str(item.get("hash") or "")[:12]
    details = [short_hash]
    if item.get("license"):
        details.append(str(item["license"]))
    if item.get("tags"):
        details.append(",".join(str(tag) for tag in item["tags"]))
    return f"{label} ({' · '.join(details)})"


def _audio_matches(matches: tuple[dict[str, Any], ...]) -> str:
    return ", ".join(_audio_item_label(item) for item in matches[:5])


class MediaCommands:
    """`CommandRouter` mixin — see the module docstring."""

    async def cmd_audio(self, ctx: CommandCtx) -> str:
        tokens = _shell_words(ctx.args)
        sub = tokens[0].casefold() if tokens else ""
        rest = tokens[1:] if tokens else []
        if sub in _AUDIO_LIST_WORDS:
            return await self._audio_list(ctx)
        if sub in _AUDIO_SET_WORDS:
            return await self._audio_set(ctx, rest)
        if sub in _AUDIO_IMPORT_WORDS:
            return await self._audio_import(ctx, rest)
        return ctx.i18n.t("commands.audio.usage")

    async def _audio_import(self, ctx: CommandCtx, rest: list[str]) -> str:
        """`.audio import <packId>` — register an installed pack's audio assets into THIS
        room's library. Packs ship soundtracks, but the room library only ever filled from
        uploads; this is the deliberate keeper lever that bridges the two (a pack install
        is host-wide, a room's soundscape is the keeper's call)."""
        if not _is_keeper(ctx.raw_ctx):
            return ctx.fail(ctx.i18n.t("rooms.denied"))
        pack_id = rest[0].strip() if rest else ""
        if not pack_id:
            return ctx.i18n.t("commands.audio.import_usage")
        import mimetypes

        from core.pack import MANIFEST_NAME, installed_pack_dir, parse_manifest_text

        pack_dir = installed_pack_dir(ctx.services.settings.data_dir, pack_id)
        if pack_dir is None:
            return ctx.i18n.t("commands.audio.import_missing", pack=pack_id)
        # Manifest titles/tags become the library metadata when present (the built
        # manifest ships with the install); a missing/unreadable manifest just
        # degrades to filename stems.
        titles: dict[str, tuple[str, tuple[str, ...]]] = {}
        try:
            manifest = parse_manifest_text((pack_dir / MANIFEST_NAME).read_text("utf-8"), expect_trust=True)
            for asset in manifest.assets:
                titles[asset.path] = (asset.title, asset.tags)
        except Exception:  # noqa: BLE001 — metadata is best-effort, import proceeds
            titles = {}
        tui_settings = ctx.services.settings.tui
        store = MediaStore(
            ctx.services.store,
            ctx.services.settings.data_dir,
            max_file_bytes=tui_settings.audio_max_file_bytes,
            room_quota_bytes=tui_settings.audio_room_quota_bytes,
            allowed_mimes=ALLOWED_AUDIO_MIMES,
        )
        imported: list[str] = []
        for path in sorted(pack_dir.rglob("*")):
            if len(imported) >= 24:
                break
            if not path.is_file():
                continue
            mime = mimetypes.guess_type(path.name)[0] or ""
            if mime not in ALLOWED_AUDIO_MIMES:
                continue
            rel = path.relative_to(pack_dir).as_posix()
            title, tags = titles.get(rel, ("", ()))
            display = title or path.stem
            try:
                record = await store.register_blob(
                    room=ctx.chat_key, data=path.read_bytes(), mime=mime, name=display, uploader=ctx.user_id
                )
            except (MediaError, OSError):
                continue
            await add_audio_item(ctx.services.store, ctx.chat_key, record, ctx.user_id)
            if title or tags:
                await update_audio_item(
                    ctx.services.store, ctx.chat_key, record.hash, {"title": display, "tags": list(tags)}
                )
            imported.append(display)
        if not imported:
            return ctx.i18n.t("commands.audio.import_none", pack=pack_id)
        return ctx.i18n.t(
            "commands.audio.import_done",
            pack=pack_id,
            count=len(imported),
            names=ctx.i18n.t("common.list_separator").join(imported),
        )

    async def cmd_bgm(self, ctx: CommandCtx) -> str:
        return await self._audio_layer(ctx, "bgm", default_loop=True)

    async def cmd_ambience(self, ctx: CommandCtx) -> str:
        return await self._audio_layer(ctx, "ambience", default_loop=True)

    async def cmd_sfx(self, ctx: CommandCtx) -> str:
        return await self._audio_layer(ctx, "sfx", default_loop=False)

    async def cmd_avatar(self, ctx: CommandCtx) -> str:
        tokens = _shell_words(ctx.args)
        sub = tokens[0].casefold() if tokens else ""
        rest = tokens[1:] if tokens else []
        if sub in _AVATAR_CLEAR_WORDS:
            return await self._avatar_clear(ctx)
        if sub in _AVATAR_GEN_WORDS:
            return await self._avatar_generate(ctx, rest)
        return ctx.i18n.t("commands.avatar.usage")

    async def _avatar_clear(self, ctx: CommandCtx) -> str:
        try:
            sheet = await set_user_avatar(ctx.services, user_id=ctx.user_id, chat_key=ctx.chat_key, avatar=None)
        except AvatarError as exc:
            return ctx.i18n.t(f"commands.avatar.error.{exc.code}")
        if ctx.router.hub is not None:
            await publish_state(ctx.router.hub, ctx.services, ctx.raw_ctx)
        return ctx.i18n.t("commands.avatar.cleared", name=sheet.name)

    async def _avatar_generate(self, ctx: CommandCtx, tokens: list[str]) -> str:
        if not tokens:
            return ctx.i18n.t("commands.avatar.usage")
        if not await is_media_enabled(ctx.services.store, ctx.chat_key):
            return ctx.i18n.t("commands.avatar.media_disabled")
        if ctx.services.imagegen is None:
            return ctx.i18n.t("commands.avatar.not_configured")

        # Resolve the target and enforce the keeper gate BEFORE consuming the shared
        # rate-limit token: a target-avatar request from a non-keeper must be denied
        # without burning the room's imagegen quota (otherwise a player could exhaust
        # it with requests that are rejected anyway).
        target_name = ""
        prompt_tokens = tokens
        if len(tokens) >= 2:
            maybe_target = tokens[0]
            target_record = await _resolve_avatar_target(ctx, maybe_target)
            if target_record is not None:
                if not _is_keeper(ctx.raw_ctx):
                    return ctx.fail(ctx.i18n.t("commands.avatar.denied"))
                target_name = maybe_target
                prompt_tokens = tokens[1:]
        prompt = " ".join(prompt_tokens).strip()
        if not prompt:
            return ctx.i18n.t("commands.avatar.usage")

        if not allow_imagegen_request(ctx.services, ctx.chat_key):
            return ctx.i18n.t("commands.avatar.rate_limited")

        if ctx.router.hub is not None:
            await ctx.router.hub.publish(
                ctx.chat_key,
                Event(kind="system", text=ctx.i18n.t("commands.avatar.generating"), data={"level": "info", "spinner": True}),
            )
        try:
            data, mime = await ctx.services.imagegen.generate(prompt, size=ctx.services.settings.imagegen.size)
            settings = ctx.services.settings.tui
            store = MediaStore(
                ctx.services.store,
                ctx.services.settings.data_dir,
                max_file_bytes=settings.media_max_file_bytes,
                room_quota_bytes=settings.media_room_quota_bytes,
                allowed_mimes=ALLOWED_IMAGE_MIMES,
            )
            record = await store.register_blob(
                room=ctx.chat_key,
                data=data,
                mime=mime,
                name=image_name("avatar", prompt),
                uploader=ctx.user_id,
            )
            if target_name:
                sheet = await set_target_avatar(ctx.services, chat_key=ctx.chat_key, target=target_name, avatar=record.ref())
            else:
                sheet = await set_user_avatar(ctx.services, user_id=ctx.user_id, chat_key=ctx.chat_key, avatar=record.ref())
            await publish_media(ctx.router.hub, ctx.services.store, ctx.chat_key, media_frame(record, from_name=sheet.name))
            if ctx.router.hub is not None:
                await publish_state(ctx.router.hub, ctx.services, ctx.raw_ctx)
            return ctx.i18n.t("commands.avatar.generated", name=sheet.name, file=record.name, hash=record.hash[:12])
        except AvatarError as exc:
            return ctx.i18n.t(f"commands.avatar.error.{exc.code}")
        except ImageGenError as exc:
            return ctx.i18n.t(f"commands.avatar.error.{exc.code}")
        except Exception as exc:
            return ctx.i18n.t("commands.avatar.failed", error=str(exc))

    async def _audio_list(self, ctx: CommandCtx) -> str:
        items = await list_audio_items(ctx.services.store, ctx.chat_key)
        if not items:
            return ctx.i18n.t("commands.audio.empty")
        lines = [_audio_item_line(item) for item in items[-25:]]
        return ctx.i18n.t("commands.audio.list", items="\n".join(lines))

    async def _audio_set(self, ctx: CommandCtx, tokens: list[str]) -> str:
        query, metadata = _split_audio_metadata(tokens)
        if not query or not metadata:
            return ctx.i18n.t("commands.audio.set_usage")
        resolved = await update_audio_item(ctx.services.store, ctx.chat_key, query, metadata)
        if resolved.status == "not_found":
            return ctx.i18n.t("commands.audio.not_found", query=query)
        if resolved.status == "ambiguous":
            return ctx.i18n.t("commands.audio.ambiguous", matches=_audio_matches(resolved.matches))
        assert resolved.item is not None
        await self._publish_audio(ctx, resolved.item)
        return ctx.i18n.t("commands.audio.updated", item=_audio_item_label(resolved.item))

    async def _audio_layer(self, ctx: CommandCtx, layer: str, *, default_loop: bool) -> str:
        tokens = _shell_words(ctx.args)
        if not tokens:
            return ctx.i18n.t(f"commands.audio.{layer}.usage")

        sub = tokens[0].casefold()
        if sub in _AUDIO_STOP_WORDS:
            return await self._audio_control(ctx, layer, "stop")
        if sub in _AUDIO_PAUSE_WORDS:
            return await self._audio_control(ctx, layer, "pause")
        if sub in _AUDIO_RESUME_WORDS:
            return await self._audio_control(ctx, layer, "resume")
        if sub in _AUDIO_VOLUME_WORDS:
            volume = _parse_audio_volume(tokens[1:])
            if volume is None:
                return ctx.i18n.t("commands.audio.volume_usage")
            return await self._audio_control(ctx, layer, "volume", volume=volume)

        play_tokens = tokens[1:] if sub in _AUDIO_PLAY_WORDS else tokens
        query, options = _split_audio_play(play_tokens, default_loop=default_loop)
        if not query:
            return ctx.i18n.t(f"commands.audio.{layer}.usage")
        resolved = await resolve_audio_item(ctx.services.store, ctx.chat_key, query)
        if resolved.status == "not_found":
            return ctx.i18n.t("commands.audio.not_found", query=query)
        if resolved.status == "ambiguous":
            return ctx.i18n.t("commands.audio.ambiguous", matches=_audio_matches(resolved.matches))
        assert resolved.item is not None
        return await self._audio_control(
            ctx,
            layer,
            "play",
            item=resolved.item,
            volume=options.get("volume"),
            loop=bool(options.get("loop")),
            fade_ms=options.get("fade_ms"),
        )

    async def _audio_control(
        self,
        ctx: CommandCtx,
        layer: str,
        action: str,
        *,
        item: dict[str, Any] | None = None,
        volume: float | None = None,
        loop: bool | None = None,
        fade_ms: int | None = None,
    ) -> str:
        control, state = await build_audio_control(
            ctx.services.store,
            ctx.chat_key,
            layer=layer,
            action=action,
            item=item,
            volume=volume,
            loop=loop,
            fade_ms=fade_ms,
        )
        await self._publish_audio(ctx, control)
        if state is not None:
            await self._publish_audio(ctx, state)
        if action == "play" and item is not None:
            return ctx.i18n.t("commands.audio.played", layer=ctx.i18n.t(f"commands.audio.layer.{layer}"), item=_audio_item_label(item))
        if action == "volume":
            return ctx.i18n.t("commands.audio.volume_done", layer=ctx.i18n.t(f"commands.audio.layer.{layer}"), volume=f"{(volume or 0) * 100:.0f}%")
        return ctx.i18n.t("commands.audio.control_done", layer=ctx.i18n.t(f"commands.audio.layer.{layer}"), action=ctx.i18n.t(f"commands.audio.action.{action}"))

    async def _publish_audio(self, ctx: CommandCtx, frame: dict[str, Any]) -> None:
        if ctx.router.hub is not None:
            await ctx.router.hub.publish(ctx.chat_key, Event.audio(frame))
