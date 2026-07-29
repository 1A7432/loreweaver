"""Full SillyTavern EJS template compatibility — real JavaScript in a QuickJS sandbox.

Where `core.ejs_lite` renders a closed SUBSET of EJS, this module runs the real thing: the
vendored official EJS library (`assets/vendor/ejs.min.js`, Apache-2.0) plus lodash
(`assets/vendor/lodash.min.js`, MIT) inside an embedded QuickJS interpreter, so imported cards
written for the ST-Prompt-Template extension execute as authored — loops, functions, template
literals, `await`, lodash chains, the lot. This is a deliberate, self-hosted trust decision
(the operator's cards, the operator's box — the same model SillyTavern itself uses; see
``docs/plugins.md``); the sandbox guardrails below are crash protection, not gatekeeping:

- hard memory cap and per-eval time cap (a `while(true)` template times out, it cannot hang the
  server), bounded async-job pump;
- ZERO Python callables inside the interpreter (the binding cannot combine them with the time
  limit anyway): every input — the merged variable snapshot, the room's worldbook contents, the
  char/chat snapshots — is serialized INTO the sandbox up front, and the ST API surface
  (``getvar``/``setvar``/``incvar``/``decvar``/``getwi``/``activewi``/``injectPrompt``/
  ``getPromptsInjected``/``getchar``/``getchat``/``define``/``print``/``execvar``/
  ``SafeGetValue``, lodash as ``_``, a stub ``faker``) is implemented in pure JS over those
  snapshots;
- no host I/O of any kind — QuickJS ships with no filesystem/network/process APIs and none are
  exposed;
- template ``setvar`` writes land in a JS-side buffer read back AFTER rendering and applied to
  the MVU variable tree by deterministic Python (`core.mvu_compat.apply_set`) — the sandbox
  never touches the store directly, and a runaway template can at most queue
  `MAX_TEMPLATE_WRITES` writes.

`FullEjsEngine` is built once per prompt assembly (`agent.prompt_builder`) and dropped after —
one interpreter per turn, so templates cannot leak state across turns or rooms. Any failure
(missing `quickjs` extra, engine init error, template error) degrades to the `core.ejs_lite`
subset via the caller, never to raw template syntax in a prompt.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from core.ejs_lite import RenderResult

logger = logging.getLogger(__name__)

MEMORY_LIMIT_BYTES = 64 * 1024 * 1024
TIME_LIMIT_SECONDS = 1
MAX_PENDING_JOBS = 10_000
MAX_TEMPLATE_WRITES = 64

_VENDOR_DIR = Path(__file__).resolve().parent.parent / "assets" / "vendor"

# The pure-JS ST-Prompt-Template API surface over the pre-serialized snapshots. Kept as one
# prelude string so the whole bridge is auditable in one place.
_PRELUDE = r"""
globalThis.__writes = [];
globalThis.__activated = [];
globalThis.__warnings = [];
globalThis.__injected = {};
globalThis.__result = null;
globalThis.__error = null;

function __isVWD(node) {
    return Array.isArray(node) && node.length === 2 && typeof node[1] === "string";
}
function SafeGetValue(node) { return __isVWD(node) ? node[0] : node; }

function __lookup(path) {
    var node = globalThis.__tree;
    var parts = String(path).split(".");
    for (var i = 0; i < parts.length; i++) {
        if (node && typeof node === "object" && !Array.isArray(node)) {
            if (!Object.prototype.hasOwnProperty.call(node, parts[i])) return undefined;
            node = node[parts[i]];
        } else if (Array.isArray(node) && !__isVWD(node)) {
            var idx = Number(parts[i]);
            if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return undefined;
            node = node[idx];
        } else {
            return undefined;
        }
    }
    return __isVWD(node) ? node[0] : node;
}

function getvar(name, opts) {
    var key = String(name);
    var stripped = key.replace(/^(variables\.|stat_data\.)/, "");
    var value;
    if (Object.prototype.hasOwnProperty.call(globalThis.__flat, stripped)) {
        value = globalThis.__flat[stripped];
    } else {
        value = __lookup(stripped);
    }
    if ((value === undefined || value === null) && opts && typeof opts === "object" && "defaults" in opts) {
        return opts.defaults;
    }
    return value;
}
function setvar(name, value) {
    globalThis.__writes.push([String(name).replace(/^(variables\.|stat_data\.)/, ""), value]);
    globalThis.__flat[String(name).replace(/^(variables\.|stat_data\.)/, "")] = value;
    return value;
}
function incvar(name, amount) {
    var base = Number(getvar(name));
    if (!isFinite(base)) base = 0;
    var delta = amount === undefined ? 1 : Number(amount);
    if (!isFinite(delta)) delta = 1;
    return setvar(name, base + delta);
}
function decvar(name, amount) {
    var delta = amount === undefined ? 1 : Number(amount);
    return incvar(name, -delta);
}
function getwi(name) {
    var key = String(name);
    return Object.prototype.hasOwnProperty.call(globalThis.__wi, key) ? globalThis.__wi[key] : "";
}
function activewi(name) { globalThis.__activated.push(String(name)); return true; }
function injectPrompt(key, content) {
    var bucket = globalThis.__injected[String(key)] || (globalThis.__injected[String(key)] = []);
    bucket.push(String(content));
}
function getPromptsInjected(key) { return (globalThis.__injected[String(key)] || []).join("\n"); }
function getchar(field) { return field === undefined ? globalThis.__char : globalThis.__char[String(field)]; }
function getchat(field) { return field === undefined ? globalThis.__chat : globalThis.__chat[String(field)]; }
function define(name, value) { globalThis[String(name)] = value; return value; }
function print(value) { return value; }
function execvar(name) {
    var code = getvar(name);
    if (typeof code !== "string" || !code) return undefined;
    return (0, eval)(code);
}
var faker = new Proxy({}, {
    get: function (_target, prop) {
        return new Proxy(function () { return ""; }, {
            get: function (_t, inner) {
                globalThis.__warnings.push("faker." + String(prop) + "." + String(inner) + " is stubbed");
                return function () { return ""; };
            },
            apply: function () {
                globalThis.__warnings.push("faker." + String(prop) + " is stubbed");
                return "";
            }
        });
    }
});

function __identity(text) { return text == null ? "" : String(text); }

function __makeData() {
    var variables = Object.assign({}, globalThis.__tree, globalThis.__flat);
    return {
        getvar: getvar, setvar: setvar, incvar: incvar, decvar: decvar,
        getwi: getwi, activewi: activewi,
        injectPrompt: injectPrompt, getPromptsInjected: getPromptsInjected,
        getchar: getchar, getchat: getchat,
        define: define, print: print, execvar: execvar,
        SafeGetValue: SafeGetValue, faker: faker,
        variables: variables, stat_data: globalThis.__tree,
        data: { stat_data: globalThis.__tree },
        _: _
    };
}

function __render(template) {
    globalThis.__result = null;
    globalThis.__error = null;
    try {
        ejs.render(template, __makeData(), { async: true, escape: __identity })
            .then(function (r) { globalThis.__result = String(r); },
                  function (e) { globalThis.__error = String((e && e.message) || e); });
    } catch (e) {
        globalThis.__error = String((e && e.message) || e);
    }
}

function __cond(source) {
    try {
        with (__makeData()) { return Boolean(eval(source)); }
    } catch (e) {
        globalThis.__warnings.push("condition: " + String((e && e.message) || e));
        return null;
    }
}
"""


class EjsFullError(RuntimeError):
    """Raised internally for engine init/render failures; callers degrade to the subset."""


def quickjs_available() -> bool:
    try:
        import quickjs  # noqa: F401
    except Exception:
        return False
    return True


class FullEjsEngine:
    """One QuickJS interpreter preloaded with EJS + lodash + the ST API bridge.

    Build via `create_full_engine` (returns `None` when unavailable). One instance serves one
    prompt assembly, then is dropped; `pending_writes`/`activated`/`warnings` are read after.
    """

    def __init__(
        self,
        *,
        flat_variables: dict[str, Any],
        tree: dict[str, Any],
        worldinfo: dict[str, str],
        char: dict[str, Any] | None = None,
        chat: dict[str, Any] | None = None,
    ) -> None:
        import quickjs

        self._context = quickjs.Context()
        self._context.set_memory_limit(MEMORY_LIMIT_BYTES)
        try:
            self._context.eval((_VENDOR_DIR / "ejs.min.js").read_text(encoding="utf-8"))
            self._context.eval((_VENDOR_DIR / "lodash.min.js").read_text(encoding="utf-8"))
            self._context.eval(_PRELUDE)
            for name, payload in (
                ("__flat", flat_variables),
                ("__tree", tree),
                ("__wi", worldinfo),
                ("__char", char or {}),
                ("__chat", chat or {}),
            ):
                self._context.eval(f"globalThis.{name} = {json.dumps(payload, ensure_ascii=False)};")
        except Exception as exc:  # noqa: BLE001 — any init failure means "engine unavailable"
            raise EjsFullError(f"engine init failed: {exc}") from exc
        # The time limit arms AFTER library/prelude/snapshot loading (those are our code and
        # legitimately take longer); every subsequent template eval is capped by it.
        self._context.set_time_limit(TIME_LIMIT_SECONDS)

    # -- rendering ---------------------------------------------------------

    def render(self, text: str) -> RenderResult:
        """Render `text` as a real async EJS template. Raises `EjsFullError` on any template
        error (the caller falls back to the `core.ejs_lite` subset — never raw syntax out)."""
        try:
            self._context.eval(f"__render({json.dumps(text, ensure_ascii=False)});")
            for _ in range(MAX_PENDING_JOBS):
                if not self._context.execute_pending_job():
                    break
            error = self._context.eval("globalThis.__error")
            if error is not None:
                raise EjsFullError(str(error))
            result = self._context.eval("globalThis.__result")
            if result is None:
                raise EjsFullError("template did not settle (async job budget exhausted)")  # i18n-exempt: developer diagnostic; callers degrade fail-safe, never show this raw to players
            return RenderResult(str(result), self._drain_warnings())
        except EjsFullError:
            raise
        except Exception as exc:  # quickjs.JSException, time/memory-limit InternalError, ...
            raise EjsFullError(str(exc)) from exc

    def eval_condition(self, expression: str) -> bool | None:
        """Evaluate a JS condition (`@@if` / entry `condition`) against the bridge scope.
        Returns `None` (⇒ caller fails closed) on any evaluation error."""
        try:
            result = self._context.eval(f"__cond({json.dumps(expression, ensure_ascii=False)})")
        except Exception:
            return None
        return result if isinstance(result, bool) else None

    # -- post-render readbacks --------------------------------------------

    @property
    def pending_writes(self) -> list[tuple[str, Any]]:
        """Template `setvar` writes, capped, in call order — apply via `core.mvu_compat`."""
        writes = self._read_json("globalThis.__writes") or []
        cleaned: list[tuple[str, Any]] = []
        for item in writes[:MAX_TEMPLATE_WRITES]:
            if isinstance(item, list) and len(item) == 2 and isinstance(item[0], str) and item[0]:
                cleaned.append((item[0], item[1]))
        return cleaned

    @property
    def activated(self) -> list[str]:
        """Worldbook entry names force-activated via `activewi()` during rendering."""
        names = self._read_json("globalThis.__activated") or []
        return [str(name) for name in names if isinstance(name, str)]

    def _drain_warnings(self) -> list[str]:
        warnings = self._read_json("globalThis.__warnings") or []
        self._context.eval("globalThis.__warnings = [];")
        return [str(warning) for warning in warnings]

    def _read_json(self, expression: str) -> Any:
        try:
            raw = self._context.eval(f"JSON.stringify({expression})")
            return json.loads(raw) if isinstance(raw, str) else None
        except Exception:
            return None


def create_full_engine(
    *,
    flat_variables: dict[str, Any],
    tree: dict[str, Any],
    worldinfo: dict[str, str],
    char: dict[str, Any] | None = None,
    chat: dict[str, Any] | None = None,
) -> FullEjsEngine | None:
    """Build a `FullEjsEngine`, or `None` when the `ejs` extra is missing or init fails —
    callers treat `None` as "use the `core.ejs_lite` subset"."""
    if not quickjs_available():
        return None
    try:
        return FullEjsEngine(
            flat_variables=flat_variables, tree=tree, worldinfo=worldinfo, char=char, chat=chat
        )
    except Exception:
        logger.warning("full-EJS engine unavailable, falling back to the subset", exc_info=True)
        return None
