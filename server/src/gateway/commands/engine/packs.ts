// Packs and skills in a room: `pack` (list the installed packs; the admin installs one from
// chat, and enables and disables them here) and `skill` (the admin lists, enables and
// disables the Keeper's skills — the built-in ones and those of the room's enabled packs).
//
// `pack install <ref>` (decision 45, as in 2.6): a room's admin installs a pack on the server
// — a path on the SERVER's disk, an https URL or `gh:owner/repo[@tag]` — with the shell's own
// installer, and the pack is enabled in this room at once with its skills. Fetching is
// network I/O, so the command runs outside the room's lock (`unlocked`): `prepare` fetches,
// then `run` installs, takes the pack into the running server and enables it, synchronously.
// The admin's one result is the trust card in words; the table hears one line.
import { localText, type TrustCard } from "../../../core/packs/index.ts";
import { panelAdminOnly, panelListedTo, panelText } from "../../../core/panels/index.ts";
import { disableSkill, enableSkill, readEnabledSkills, skillDescription, skillName, writeEnabledSkills } from "../../../core/skills/index.ts";
import type { LoadedPack, RoomPacks, RuntimeInstallOutcome } from "../../packs.ts";
import { firstWord } from "../parse.ts";
import { compact, object, oneOf, text } from "../schema.ts";
import { MAX_ENABLED_PACKS, ROOM_PACKS, ROOM_PANELS_OFF } from "../state.ts";
import { type Args, type CommandCall, type CommandSpec, type Done, isRefused, refuse, type Refused } from "../types.ts";

const LIST_WORDS: ReadonlySet<string> = new Set(["list", "ls", "列表", "列出"]);
const ENABLE_WORDS: ReadonlySet<string> = new Set(["enable", "on", "启用", "啟用", "开启", "開啟"]);
const DISABLE_WORDS: ReadonlySet<string> = new Set(["disable", "off", "停用", "关闭", "關閉"]);

/** `list` | `enable <id>` | `disable <id>` as an argument object. */
function parseSwitch(rest: string): Readonly<Record<string, unknown>> | Refused {
  const [word, after] = firstWord(rest);
  if (word === "" || LIST_WORDS.has(word)) return after === "" ? { op: "list" } : refuse("usage");
  const op = ENABLE_WORDS.has(word) ? "enable" : DISABLE_WORDS.has(word) ? "disable" : null;
  if (op === null) return refuse("usage");
  const [id, extra] = firstWord(after);
  if (id === "" || extra !== "") return refuse("usage");
  return compact({ op, id });
}

const SWITCH_PARAMS = object({ op: oneOf(["list", "enable", "disable"]), id: text(64, 1) }, ["op"]);

const INSTALL_WORDS: ReadonlySet<string> = new Set(["install", "add", "安装", "安裝"]);
/** The longest pack reference `pack install` takes (a path, a URL or a `gh:` reference). */
export const MAX_PACK_REF_CHARS = 2000;
const PACK_PARAMS = object({ op: oneOf(["list", "enable", "disable", "install"]), id: text(64, 1), ref: text(MAX_PACK_REF_CHARS, 1) }, ["op"]);

/** `install <ref>` (the reference as typed, case kept), or what `parseSwitch` reads. */
function parsePack(rest: string): Readonly<Record<string, unknown>> | Refused {
  const [word, after] = firstWord(rest);
  if (INSTALL_WORDS.has(word)) return after === "" ? refuse("usage") : { op: "install", ref: after };
  return parseSwitch(rest);
}

/** What `prepare` fetched for `install`. */
interface Fetched {
  readonly archive: Uint8Array;
}

/** A source refusal, as this command states it (codes that would read wrongly bare get a prefix). */
function sourceRefusal(code: string, detail: string | undefined): Refused {
  const stated = code === "not_found" ? "source_not_found" : code === "too_large" ? "archive_too_large" : code;
  return refuse(stated, { detail: detail ?? "" });
}

/** An installer refusal, as this command states it. */
function installRefusal(outcome: Extract<RuntimeInstallOutcome, { ok: false }>): Refused {
  if (outcome.code.startsWith("zip_")) return refuse("bad_archive", { problem: outcome.code.slice(4), path: outcome.path ?? "" });
  if (outcome.code === "invalid_pack") {
    const first = outcome.problems?.[0];
    return refuse("invalid_pack", { problem: first?.code ?? "", path: first?.path ?? "", count: outcome.problems?.length ?? 0 });
  }
  return refuse(outcome.code, { detail: outcome.detail ?? "" });
}

/** The trust card in words, in the caller's language: does it run code, what it adds, what was ignored or left out. */
function trustLines(call: CommandCall, trust: TrustCard, shadowed: { readonly ruleSystems: readonly string[]; readonly skills: readonly string[] }): string[] {
  const separator = call.say("list.separator");
  const lines: string[] = [];
  lines.push(trust.runsCode ? call.say("pack.trust_runs_code", { list: trust.modules.map((module) => module.id).join(separator) }) : call.say("pack.trust_no_code"));
  const list = (key: string, items: readonly string[]): void => {
    if (items.length > 0) lines.push(call.say(key, { list: items.join(separator) }));
  };
  list("pack.part_systems", trust.ruleSystems.map((system) => (system.extends === null ? system.id : call.say("pack.trust_extends", { id: system.id, base: system.extends }))));
  list(
    "pack.part_skills",
    trust.skills.map((skill) => {
      const marks = [...(skill.tools.length > 0 ? [call.say("pack.trust_tools", { list: skill.tools.join(separator) })] : []), ...(skill.mature ? [call.say("pack.trust_mature")] : [])];
      return marks.length === 0 ? skill.id : `${skill.id} (${marks.join(separator)})`;
    }),
  );
  list("pack.part_cards", trust.cards.map((card) => call.say("pack.card", { name: card.name, file: card.path, kind: call.say(`pack.kind_${card.kind}`) })));
  list("pack.part_panels", trust.panels.map((panel) => panel.id));
  if (trust.presentation !== null) lines.push(call.say("pack.part_kit"));
  if (trust.assets.count > 0) lines.push(call.say("pack.part_assets", { count: trust.assets.count }));
  list("pack.trust_ignored", trust.ignored.map((item) => call.say("pack.trust_ignored_item", { path: item.path, reason: call.say(`pack.ignored_${item.reason}`) })));
  list("pack.trust_left_out", [...shadowed.ruleSystems, ...shadowed.skills]);
  return lines;
}

/** `pack install`, once `prepare` fetched the archive: install, take it in, enable it here with its skills. */
function install(packs: RoomPacks, call: CommandCall, prepared: unknown): Done | Refused {
  if (isRefused(prepared)) return prepared;
  if (prepared === undefined) return refuse("install_unavailable");
  const { services, room, writer } = call.context;
  const store = services.store;
  // The room moved to another generation during the fetch: refuse before anything is written.
  if (!writer.current()) return refuse("stale_generation");
  const outcome = packs.install((prepared as Fetched).archive);
  if (!outcome.ok) return installRefusal(outcome);
  const loaded = outcome.loaded;
  const id = outcome.id;
  const name = packName(loaded, call.locale);
  const switched = packs.enable(store, room, id);
  const newly = switched.ok && switched.changed;
  if (newly) writer.statePut(ROOM_PACKS, [...switched.ids]);
  // As 2.6: installing from chat switches the pack's skills on in this room (not the ones a
  // built-in or an earlier pack keeps the id of — those are named as left out).
  const skillsOn: string[] = [];
  if (switched.ok) {
    let skills = readEnabledSkills(store, room);
    for (const skill of packs.ownSkills(loaded)) {
      const on = enableSkill(packs.skillRegistry, skills, skill);
      if (on.ok && on.changed) {
        skills = on.enabled;
        skillsOn.push(skill);
      }
    }
    if (skillsOn.length > 0) writeEnabledSkills(writer, skills);
  }
  const head = outcome.replaced === null ? "pack.installed" : "pack.upgraded";
  const lines = [call.say(head, { name, id, version: outcome.version, previous: outcome.replaced ?? "" })];
  if (switched.ok) lines.push(call.say("pack.installed_enabled"));
  else lines.push(call.say("pack.installed_not_enabled", { reason: call.say(`error.${switched.code}`, { id, limit: MAX_ENABLED_PACKS, module: switched.detail ?? "" }) }));
  lines.push(...trustLines(call, outcome.trust, outcome.shadowed));
  if (skillsOn.length > 0) lines.push(call.say("pack.skills_enabled", { list: skillsOn.join(call.say("list.separator")) }));
  if (switched.ok) for (const card of loaded.pack.cards.filter((each) => each.kind === "world")) lines.push(call.say("pack.import_world", { id, card: card.path }));
  const tableName = localText(loaded.pack.manifest.name, call.context.locale) || id;
  return {
    text: lines.join("\n"),
    data: { id, version: outcome.version, replaced: outcome.replaced, sha256: outcome.sha256, enabled: switched.ok, skillsEnabled: skillsOn, shadowed: outcome.shadowed, trust: outcome.trust },
    events: [{ kind: "narrative", data: { speaker: "system", text: call.tell(switched.ok ? "pack.event_installed" : "pack.event_installed_only", { name: tableName }), format: "plain" } }],
    // Newly enabled here: the worker restarts with its modules (behind any turn in flight).
    // A room that already had it enabled reloads through `RoomPacks.onInstalled`.
    ...(newly
      ? {
          modulesChanged: true,
          after: async () => {
            const problems = await packs.registerAssets(room, store);
            return problems.length === 0 ? [] : [call.say("pack.assets_failed", { count: problems.length })];
          },
        }
      : {}),
  };
}

function packName(loaded: LoadedPack, locale: string): string {
  return localText(loaded.pack.manifest.name, locale) || loaded.pack.manifest.id;
}

/** What a pack carries, as the admin's list shows it and as `data` holds it. */
function packSummary(packs: RoomPacks, call: CommandCall, loaded: LoadedPack, enabled: boolean): Record<string, unknown> {
  const { pack } = loaded;
  const systems = call.context.services.packs;
  const shadowedSystems = pack.ruleSystems.filter((system) => systems.get(system.id) !== system.compiled).map((system) => system.id);
  const own = new Set(packs.ownSkills(loaded));
  return {
    id: pack.manifest.id,
    version: pack.manifest.version,
    name: packName(loaded, call.locale),
    enabled,
    modules: pack.modules.map((module) => module.id),
    ruleSystems: pack.ruleSystems.map((system) => system.id),
    skills: pack.skills.map((entry) => entry.id),
    cards: pack.cards.map((card) => ({ file: card.path, name: card.name, kind: card.kind })),
    panels: pack.panels.map((panel) => panel.spec.id),
    presentation: pack.presentation !== null,
    assets: pack.assets.length,
    shadowed: [...shadowedSystems, ...pack.skills.filter((entry) => !own.has(entry.id)).map((entry) => entry.id)],
  };
}

function adminLine(call: CommandCall, summary: Record<string, unknown>): string {
  const separator = call.say("list.separator");
  const parts: string[] = [];
  const list = (key: string, items: readonly string[]): void => {
    if (items.length > 0) parts.push(call.say(key, { list: items.join(separator) }));
  };
  list("pack.part_modules", summary.modules as string[]);
  list("pack.part_systems", summary.ruleSystems as string[]);
  list("pack.part_skills", summary.skills as string[]);
  list("pack.part_cards", (summary.cards as { file: string; name: string; kind: string }[]).map((card) => call.say("pack.card", { name: card.name, file: card.file, kind: call.say(`pack.kind_${card.kind}`) })));
  list("pack.part_panels", summary.panels as string[]);
  if (summary.presentation === true) parts.push(call.say("pack.part_kit"));
  if ((summary.assets as number) > 0) parts.push(call.say("pack.part_assets", { count: summary.assets as number }));
  list("pack.part_shadowed", summary.shadowed as string[]);
  const head = call.say(summary.enabled === true ? "pack.line_enabled" : "pack.line", { name: summary.name as string, id: summary.id as string, version: summary.version as string });
  return parts.length === 0 ? head : `${head}\n  ${parts.join("\n  ")}`;
}

/** `pack`: anyone sees the packs enabled here, by name; the admin sees every installed pack, installs one, and switches them. */
export function packCommand(packs: RoomPacks): CommandSpec {
  return {
    id: "pack",
    source: "engine",
    key: "pack",
    params: PACK_PARAMS,
    text: { en: ["pack", "packs"], zh: ["pack", "扩展包", "擴展包"] },
    role: "player",
    adminWhen: (args) => args.op !== "list",
    unlocked: (args: Args) => args.op === "install",
    parseText: (rest) => parsePack(rest),
    async prepare(_call, args): Promise<Fetched | Refused | undefined> {
      if (args.op !== "install") return undefined;
      if (!packs.canInstall) return refuse("install_unavailable");
      if (args.ref === undefined) return refuse("missing_arg", { path: "ref" });
      const source = await packs.fetchSource(args.ref as string);
      if (!source.ok) return sourceRefusal(source.code, source.detail);
      return { archive: source.bytes };
    },
    run(call, args, prepared): Done | Refused {
      if (args.op === "install") return install(packs, call, prepared);
      const { services, room, writer } = call.context;
      const store = services.store;
      const enabledIds = packs.enabledIds(store, room);
      if (args.op === "list") {
        if (call.context.who.member?.role !== "admin") {
          // A player sees what this room plays with, by name only.
          const names = packs.enabled(store, room).map((loaded) => ({ id: loaded.pack.manifest.id, name: packName(loaded, call.locale) }));
          if (names.length === 0) return { text: call.say("pack.none_enabled"), data: { packs: [] } };
          return { text: [call.say("pack.header_player"), ...names.map((entry) => call.say("pack.line_player", { name: entry.name }))].join("\n"), data: { packs: names } };
        }
        const summaries = packs.installed().map((loaded) => packSummary(packs, call, loaded, enabledIds.includes(loaded.pack.manifest.id)));
        if (summaries.length === 0) return { text: call.say("pack.none_installed"), data: { packs: [] } };
        return { text: [call.say("pack.header_admin"), ...summaries.map((summary) => adminLine(call, summary))].join("\n"), data: { packs: summaries } };
      }
      const id = args.id as string | undefined;
      if (id === undefined) return refuse("missing_arg", { path: "id" });
      if (args.op === "enable") {
        const switched = packs.enable(store, room, id);
        if (!switched.ok) return refuse(switched.code, { id, limit: MAX_ENABLED_PACKS, module: switched.detail ?? "" });
        const loaded = packs.get(id) as LoadedPack;
        const name = packName(loaded, call.locale);
        if (!switched.changed) return { text: call.say("pack.already_enabled", { name }), data: { id, enabled: true, changed: false } };
        writer.statePut(ROOM_PACKS, [...switched.ids]);
        const lines = [call.say("pack.enabled", { name })];
        const skills = packs.ownSkills(loaded);
        if (skills.length > 0) lines.push(call.say("pack.skills_available", { list: skills.join(call.say("list.separator")) }));
        if (loaded.pack.cards.length > 0) lines.push(call.say("pack.cards_available", { count: loaded.pack.cards.length }));
        return {
          text: lines.join("\n"),
          data: { id, enabled: true, changed: true },
          events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("pack.event_enabled", { name: localText(loaded.pack.manifest.name, call.context.locale) || id }), format: "plain" } }],
          modulesChanged: true,
          // The kit's pictures and sounds become this room's media once the switch committed.
          after: async () => {
            const problems = await packs.registerAssets(room, store);
            return problems.length === 0 ? [] : [call.say("pack.assets_failed", { count: problems.length })];
          },
        };
      }
      if (!enabledIds.includes(id)) return { text: call.say("pack.already_disabled", { id }), data: { id, enabled: false, changed: false } };
      const remaining = enabledIds.filter((item) => item !== id);
      if (remaining.length === 0) writer.stateDelete(ROOM_PACKS);
      else writer.statePut(ROOM_PACKS, remaining);
      // The pack's own skills go with it: a skill the room can no longer enable is not left on.
      const loaded = packs.get(id);
      const dropped: string[] = [];
      if (loaded !== null) {
        let skills = readEnabledSkills(store, room);
        for (const skill of packs.ownSkills(loaded)) {
          const off = disableSkill(skills, skill);
          if (off.ok && off.changed) {
            skills = off.enabled;
            dropped.push(skill);
          }
        }
        if (dropped.length > 0) writeEnabledSkills(writer, skills);
      }
      const name = loaded === null ? id : packName(loaded, call.locale);
      const lines = [call.say("pack.disabled", { name })];
      if (dropped.length > 0) lines.push(call.say("pack.skills_dropped", { list: dropped.join(call.say("list.separator")) }));
      return {
        text: lines.join("\n"),
        data: { id, enabled: false, changed: true, skillsDisabled: dropped },
        events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("pack.event_disabled", { name: loaded === null ? id : localText(loaded.pack.manifest.name, call.context.locale) || id }), format: "plain" } }],
        modulesChanged: true,
      };
    },
  };
}

/** `skill`: the admin lists the skills this room can enable (built-in and its packs'), and switches them. */
export function skillCommand(packs: RoomPacks): CommandSpec {
  return {
    id: "skill",
    source: "engine",
    key: "skill",
    params: SWITCH_PARAMS,
    text: { en: ["skill", "skills"], zh: ["skill", "技能"] },
    role: "admin",
    parseText: (rest) => parseSwitch(rest),
    run(call, args): Done | Refused {
      const { services, room, writer } = call.context;
      const store = services.store;
      const available = packs.skillsFor(store, room);
      const enabled = readEnabledSkills(store, room);
      if (args.op === "list") {
        const entries = available.map(({ skill, pack }) => ({
          id: skill.id,
          name: skillName(skill, call.locale),
          description: skillDescription(skill, call.locale),
          pack,
          tools: [...skill.allowedTools],
          enabled: enabled.includes(skill.id),
        }));
        const lines = [call.say("skill.header")];
        for (const entry of entries) {
          const head = call.say(entry.enabled ? "skill.line_enabled" : "skill.line", { name: entry.name, id: entry.id, source: entry.pack === null ? call.say("skill.builtin") : entry.pack });
          lines.push(entry.description === "" ? head : `${head}: ${entry.description}`);
          if (entry.tools.length > 0) lines.push(`  ${call.say("skill.tools", { list: entry.tools.join(call.say("list.separator")) })}`);
        }
        return { text: lines.join("\n"), data: { skills: entries } };
      }
      const id = args.id as string | undefined;
      if (id === undefined) return refuse("missing_arg", { path: "id" });
      const entry = available.find((item) => item.skill.id === id);
      if (args.op === "enable") {
        if (entry === undefined) return refuse("skill_not_available", { id });
        const switched = enableSkill(packs.skillRegistry, enabled, id);
        if (!switched.ok) return refuse(switched.code === "too_many" ? "too_many_skills" : "skill_not_available", { id });
        const name = skillName(entry.skill, call.locale);
        if (!switched.changed) return { text: call.say("skill.already_enabled", { name }), data: { id, enabled: true, changed: false } };
        writeEnabledSkills(writer, switched.enabled);
        return {
          text: call.say("skill.enabled", { name }),
          data: { id, enabled: true, changed: true },
          events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("skill.event_enabled", { name: skillName(entry.skill, call.context.locale) }), format: "plain" } }],
        };
      }
      const switched = disableSkill(enabled, id);
      if (!switched.ok || !switched.changed) return { text: call.say("skill.already_disabled", { id }), data: { id, enabled: false, changed: false } };
      writeEnabledSkills(writer, switched.enabled);
      const name = entry === undefined ? id : skillName(entry.skill, call.locale);
      return {
        text: call.say("skill.disabled", { name }),
        data: { id, enabled: false, changed: true },
        events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("skill.event_disabled", { name: entry === undefined ? id : skillName(entry.skill, call.context.locale) }), format: "plain" } }],
      };
    },
  };
}

const PANEL_SWITCH_PARAMS = object({ op: oneOf(["list", "enable", "disable"]), id: text(129, 1) }, ["op"]);

/**
 * `panels`: the panels of the room's enabled packs. Anyone sees the ones listed to them; the
 * admin sees every one and switches each on or off for this room (`room.panels_off`). A panel
 * is on by default once its pack is enabled; the switch is the override, and it survives
 * every reset.
 */
export function panelsCommand(packs: RoomPacks): CommandSpec {
  return {
    id: "panels",
    source: "engine",
    key: "panels",
    params: PANEL_SWITCH_PARAMS,
    text: { en: ["panels", "panel"], zh: ["panels", "面板", "模组面板"] },
    role: "player",
    observers: true,
    adminWhen: (args) => args.op !== "list",
    parseText: (rest) => parseSwitch(rest),
    run(call, args): Done | Refused {
      const { services, room, writer } = call.context;
      const store = services.store;
      const all = packs.panels(store, room);
      const role = call.context.who.member?.role ?? "observer";
      if (args.op === "list") {
        const shown = role === "admin" ? all : all.filter((entry) => entry.on && panelListedTo(entry.panel.spec, role));
        const entries = shown.map((entry) => ({
          id: entry.id,
          title: panelText(entry.panel.spec.title, call.locale) || entry.panel.spec.id,
          kind: entry.panel.spec.kind,
          views: entry.panel.spec.views.map((ref) => ref.view),
          ...(role === "admin" ? { on: entry.on, adminOnly: panelAdminOnly(entry.panel.spec) } : {}),
        }));
        if (entries.length === 0) return { text: call.say("panels.none"), data: { panels: [] } };
        const lines = [call.say(role === "admin" ? "panels.header_admin" : "panels.header_player")];
        for (const entry of entries) {
          const marks = [entry.kind === "page" ? call.say("panels.mark_page") : "", entry.adminOnly === true ? call.say("panels.mark_admin") : ""].filter((mark) => mark !== "");
          const line = call.say(entry.on === false ? "panels.line_off" : "panels.line", { title: entry.title, id: entry.id });
          lines.push(marks.length === 0 ? line : `${line} ${marks.join(" ")}`);
        }
        return { text: lines.join("\n"), data: { panels: entries } };
      }
      const id = args.id as string | undefined;
      if (id === undefined) return refuse("missing_arg", { path: "id" });
      const found = all.find((entry) => entry.id === id);
      if (found === undefined) return refuse("panel_not_available", { id });
      const title = panelText(found.panel.spec.title, call.locale) || found.panel.spec.id;
      // Ids of packs no longer installed are dropped; those of installed packs stay, so a
      // pack disabled and enabled again keeps its panels as the admin left them.
      const off = packs.panelsOff(store, room).filter((item) => packs.get(item.split("/")[0] ?? "") !== null);
      if (args.op === "enable") {
        if (found.on) return { text: call.say("panels.already_enabled", { title }), data: { id, on: true, changed: false } };
        const remaining = off.filter((item) => item !== id);
        if (remaining.length === 0) writer.stateDelete(ROOM_PANELS_OFF);
        else writer.statePut(ROOM_PANELS_OFF, remaining);
        return {
          text: call.say("panels.enabled", { title }),
          data: { id, on: true, changed: true },
          // Its pictures and page become this room's media once the switch committed.
          after: async () => {
            const problems = await packs.registerAssets(room, store);
            return problems.length === 0 ? [] : [call.say("pack.assets_failed", { count: problems.length })];
          },
        };
      }
      if (!found.on) return { text: call.say("panels.already_disabled", { title }), data: { id, on: false, changed: false } };
      writer.statePut(ROOM_PANELS_OFF, [...off, id]);
      return { text: call.say("panels.disabled", { title }), data: { id, on: false, changed: true } };
    },
  };
}
