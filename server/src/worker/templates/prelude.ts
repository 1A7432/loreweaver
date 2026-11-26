/**
 * The JavaScript that runs INSIDE each template context, kept as two source strings so
 * the whole bridge is auditable in one place. Nothing from the host is ever handed into
 * the context except primitive strings: an object of the host realm would hand content
 * the host's `Function` constructor (`obj.constructor.constructor("return process")()`),
 * which is the classic `node:vm` escape.
 *
 * ENVIRONMENT (runs before the libraries, so lodash captures the patched builtins):
 * - `Math.random` becomes a seeded sfc32 stream and `Date` a clock fixed at the request's
 *   `nowMs`, so an assembly is a function of its request;
 * - removed: `console` (replaced by no-ops: it writes to the host's stdout), `Temporal`
 *   (wall clock), `ShadowRealm`, `WebAssembly`, `SharedArrayBuffer` and `Atomics`
 *   (`Atomics.wait` blocks the thread past any timeout), `WeakRef` and
 *   `FinalizationRegistry` (garbage-collector timing).
 *
 * API (after EJS and lodash; the surface of ST-Prompt-Template's `prepareContext`, the
 * parts this engine supports — see `function/ejs.ts` and `function/variables.ts` in
 * github.com/zonde306/ST-Prompt-Template):
 * - `getvar(name, {defaults})`: module variables first, then the MVU tree by dotted
 *   path (`variables.` / `stat_data.` stripped, `[value, "description"]` leaves
 *   unwrapped); a template sees its own earlier writes;
 * - `setvar`, `incvar`, `decvar`: buffered writes (at most the payload's cap per
 *   assembly), never touching engine state;
 * - `getwi(name)` / `getwi(book, name)` (+ `getWorldInfo`): an entry's raw content by
 *   title, disabled entries included (ST-PT renders the content as a template; this
 *   engine returns it as stored);
 * - `activewi(name)`: requests an entry for the lore step's extra pass;
 * - `injectPrompt` / `getPromptsInjected`, `getchar` / `getchat` (snapshots), `define`
 *   (persists across the renders of ONE assembly, returns the old value like ST-PT's
 *   `boundedDefine`), `execvar`, `SafeGetValue`, `faker` (stubbed: every call returns ""
 *   and records a warning), `variables` (tree merged with module variables, a snapshot
 *   taken when the render starts), `stat_data` (the raw tree), lodash as `_`;
 * - `print(...)` writes to the template output: ST-PT compiles with
 *   `outputFunctionName: 'print'` and does not shadow it in the context;
 * - the escape function returns its input (ST-PT `escape`: "don't escape any XML tags").
 *
 * Each render gets a generation number; API functions bound to an older render ignore
 * writes and activations, so a promise a failed render left pending cannot act later
 * (only microtasks run in a context, and only during the host's own calls into it).
 */

export const ENVIRONMENT_SOURCE = String.raw`(function () {
  "use strict";
  var boot = JSON.parse(globalThis.__lwBoot);
  delete globalThis.__lwBoot;
  var h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  var seed = String(boot.seed);
  for (var i = 0; i < seed.length; i++) {
    var k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  var a = h1 >>> 0, b = h2 >>> 0, c = h3 >>> 0, d = h4 >>> 0;
  function next32() {
    var t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  }
  for (var j = 0; j < 12; j++) next32();
  Math.random = function random() { return next32() / 4294967296; };

  var RealDate = Date;
  var NOW = Number(boot.now);
  function FixedDate() {
    if (!new.target) return new RealDate(NOW).toString();
    if (arguments.length === 0) return new RealDate(NOW);
    return Reflect.construct(RealDate, arguments, new.target);
  }
  FixedDate.prototype = RealDate.prototype;
  FixedDate.now = function now() { return NOW; };
  FixedDate.parse = RealDate.parse;
  FixedDate.UTC = RealDate.UTC;
  globalThis.Date = FixedDate;

  ["console", "Temporal", "ShadowRealm", "WebAssembly", "SharedArrayBuffer", "Atomics", "WeakRef", "FinalizationRegistry"].forEach(function (name) {
    try { delete globalThis[name]; } catch (e) { /* not deletable: overwritten below */ }
    try { if (name !== "console" && name in globalThis) globalThis[name] = undefined; } catch (e) { /* ignore */ }
  });
  var quiet = function () {};
  globalThis.console = { log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet };
})();`;

export const API_SOURCE = String.raw`(function () {
  "use strict";
  var payload = JSON.parse(globalThis.__lwPayload);
  delete globalThis.__lwPayload;
  var ejsLib = globalThis.ejs;
  var lodash = globalThis._;
  var stringify = JSON.stringify;
  var hasOwn = Object.prototype.hasOwnProperty;
  var defineProperty = Object.defineProperty;
  var keysOf = Object.keys;
  var isArray = Array.isArray;
  var promiseThen = Promise.prototype.then;
  var promiseResolve = Promise.resolve.bind(Promise);
  var limits = payload.limits;
  var flat = payload.flat;
  var tree = payload.tree;
  var charSnap = payload.character;
  var chatSnap = payload.chat;
  var worldInfo = new Map();
  payload.worldInfo.forEach(function (pair) { worldInfo.set(pair[0], pair[1]); });
  var defines = Object.create(null);
  var injected = new Map();
  var injectedCount = 0;
  var generation = 0;
  var totalWrites = payload.writesSoFar;
  var totalActivations = payload.activationsSoFar;
  var box = { writes: [], activations: [], warnings: [], dropped: 0, oversize: 0 };
  var outcome = null;

  function put(target, key, value) {
    defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
  }
  function message(error) {
    try { return String((error && error.message) || error).slice(0, 500); } catch (e) { return ""; }
  }
  function warn(text) {
    if (box.warnings.length < limits.warnings) box.warnings.push(String(text).slice(0, 200));
  }
  function isVWD(node) { return isArray(node) && node.length === 2 && typeof node[1] === "string"; }
  function SafeGetValue(node) { return isVWD(node) ? node[0] : node; }
  function strip(name) { return String(name).replace(/^(variables\.|stat_data\.)/, ""); }
  function lookup(path) {
    var node = tree;
    var parts = path.split(".");
    if (parts.length > 32) return undefined;
    for (var i = 0; i < parts.length; i++) {
      if (isArray(node)) {
        if (isVWD(node)) return undefined;
        if (!/^\d{1,9}$/.test(parts[i])) return undefined;
        var index = Number(parts[i]);
        if (index >= node.length) return undefined;
        node = node[index];
      } else if (node !== null && typeof node === "object") {
        if (!hasOwn.call(node, parts[i])) return undefined;
        node = node[parts[i]];
      } else {
        return undefined;
      }
    }
    return isVWD(node) ? node[0] : node;
  }
  function readVar(name) {
    var key = strip(name);
    return hasOwn.call(flat, key) ? flat[key] : lookup(key);
  }
  function merged(first, second) {
    var out = {};
    [first, second].forEach(function (source) {
      keysOf(source).forEach(function (key) { put(out, key, source[key]); });
    });
    return out;
  }

  var faker = new Proxy({}, {
    get: function (_target, group) {
      return new Proxy(function () { return ""; }, {
        get: function (_t, member) {
          return function () { warn("faker." + String(group) + "." + String(member) + " is stubbed"); return ""; };
        },
        apply: function () { warn("faker." + String(group) + " is stubbed"); return ""; }
      });
    }
  });

  function makeData(mine) {
    function live() { return mine === generation; }
    function getvar(name, options) {
      var value = readVar(name);
      if ((value === undefined || value === null) && options && typeof options === "object" && "defaults" in options) return options.defaults;
      return value;
    }
    function setvar(name, value) {
      var key = strip(name);
      if (!live()) return value;
      put(flat, key, value);
      if (totalWrites >= limits.writes) { box.dropped++; return value; }
      var json;
      try { json = stringify(value === undefined ? null : value); } catch (e) { json = undefined; }
      if (typeof json !== "string" || json.length > limits.writeChars) { box.oversize++; return value; }
      box.writes.push([key, json]);
      totalWrites++;
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
    function getwi(bookOrName, name) {
      var key = (typeof name === "string" || typeof name === "number") ? String(name) : String(bookOrName);
      return worldInfo.has(key) ? worldInfo.get(key) : "";
    }
    function activewi(name) {
      if (live() && totalActivations < limits.activations) { box.activations.push(String(name).slice(0, 200)); totalActivations++; }
      return true;
    }
    function injectPrompt(key, content) {
      if (!live() || injectedCount >= limits.injections) return;
      var bucketKey = String(key);
      var bucket = injected.get(bucketKey);
      if (bucket === undefined) { bucket = []; injected.set(bucketKey, bucket); }
      bucket.push(String(content).slice(0, limits.writeChars));
      injectedCount++;
    }
    function getPromptsInjected(key) { var bucket = injected.get(String(key)); return bucket ? bucket.join("\n") : ""; }
    function getchar(field) { return field === undefined ? charSnap : (hasOwn.call(charSnap, String(field)) ? charSnap[String(field)] : undefined); }
    function getchat(field) { return field === undefined ? chatSnap : (hasOwn.call(chatSnap, String(field)) ? chatSnap[String(field)] : undefined); }
    function define(name, value) {
      var key = String(name);
      var old = defines[key];
      if (live()) {
        defines[key] = value;
        // ST-PT's boundedDefine also sets the name on the current context (_.set(this, ...)).
        put(data, key, value);
      }
      return old;
    }
    function execvar(name) {
      var code = getvar(name);
      if (typeof code !== "string" || !code) return undefined;
      return (0, eval)(code);
    }
    var data = {
      getvar: getvar, setvar: setvar, incvar: incvar, decvar: decvar,
      getwi: getwi, getWorldInfo: getwi, activewi: activewi,
      injectPrompt: injectPrompt, getPromptsInjected: getPromptsInjected,
      getchar: getchar, getchr: getchar, getChara: getchar, getchat: getchat,
      define: define, execvar: execvar, SafeGetValue: SafeGetValue, faker: faker,
      variables: merged(tree, flat), stat_data: tree, data: { stat_data: tree }, _: lodash
    };
    keysOf(defines).forEach(function (key) { put(data, key, defines[key]); });
    return data;
  }

  function identity(value) { return value; }
  var conditionFn = new Function("__lwData", "__lwSource", "with (__lwData) { return eval(__lwSource); }");

  function render(source) {
    generation++;
    var mine = generation;
    outcome = null;
    var fn;
    try {
      fn = ejsLib.compile(String(source), { async: true, outputFunctionName: "print", _with: true, localsName: "locals", escape: identity, strict: false });
    } catch (error) {
      outcome = { ok: false, code: "syntax", detail: message(error) };
      return;
    }
    var pending;
    try {
      pending = fn(makeData(mine));
    } catch (error) {
      outcome = { ok: false, code: "runtime", detail: message(error) };
      return;
    }
    promiseThen.call(promiseResolve(pending), function (text) {
      if (mine === generation) outcome = { ok: true, text: String(text) };
    }, function (error) {
      if (mine === generation) outcome = { ok: false, code: "runtime", detail: message(error) };
    });
  }

  function take() {
    var result = outcome === null ? { ok: false, code: "unsettled" } : outcome;
    outcome = null;
    generation++;
    var out = stringify({ outcome: result, writes: box.writes, activations: box.activations, warnings: box.warnings, dropped: box.dropped, oversize: box.oversize });
    box = { writes: [], activations: [], warnings: [], dropped: 0, oversize: 0 };
    return out;
  }

  function condition(source) {
    generation++;
    try {
      return Boolean(conditionFn(makeData(generation), String(source)));
    } catch (error) {
      return null;
    } finally {
      generation++;
    }
  }

  defineProperty(globalThis, "__lw", {
    value: Object.freeze({ render: render, take: take, condition: condition }),
    writable: false,
    enumerable: false,
    configurable: false
  });
})();`;
