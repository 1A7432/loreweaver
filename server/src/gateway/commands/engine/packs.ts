// Packs and skills in a room: `pack` (list the installed packs; the admin enables and
// disables them here) and `skill` (the admin lists, enables and disables the Keeper's
// skills — the built-in ones and those of the room's enabled packs).
//
// Installing a pack is the operator's action from the shell (`loreweaver install`): a pack's
// modules run as real code in the server's process, so which code the server runs is not a
// room admin's decision. A room admin decides what of the installed content this room uses.
import { localText } from "../../../core/packs/index.ts";
import { panelAdminOnly, panelListedTo, panelText } from "../../../core/panels/index.ts";
import { disableSkill, enableSkill, readEnabledSkills, skillDescription, skillName, writeEnabledSkills } from "../../../core/skills/index.ts";
import type { LoadedPack, RoomPacks } from "../../packs.ts";
import { firstWord } from "../parse.ts";
import { compact, object, oneOf, text } from "../schema.ts";
import { MAX_ENABLED_PACKS, ROOM_PACKS, ROOM_PANELS_OFF } from "../state.ts";
import { type CommandCall, type CommandSpec, type Done, refuse, type Refused } from "../types.ts";

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

/** `pack`: anyone sees the packs enabled here, by name; the admin sees every installed pack, and switches them. */
export function packCommand(packs: RoomPacks): CommandSpec {
  return {
    id: "pack",
    source: "engine",
    key: "pack",
    params: SWITCH_PARAMS,
    text: { en: ["pack", "packs"], zh: ["pack", "扩展包", "擴展包"] },
    role: "player",
    adminWhen: (args) => args.op !== "list",
    parseText: (rest) => parseSwitch(rest),
    run(call, args): Done | Refused {
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
