// The trust card: what installing a pack means, as plain data for the person deciding —
// before anything is written. It says, first, whether the pack runs code (and which
// modules: 3.0 modules run in the server's process with no sandbox), then what it adds
// (rule systems, skills and the tools each unlocks, cards and the world machinery they
// carry, the panels and the views they read, the presentation kit, assets and their bytes), and what was ignored (a 2.x
// `hooks.js`, files the manifest does not name, unknown manifest keys). It is computed
// from the validated pack, so it cannot understate what the pack ships.
import type { LocalText } from "./manifest.ts";
import type { IgnoredReason, Pack } from "./read.ts";

export interface TrustCard {
  readonly id: string;
  readonly version: string;
  readonly name: LocalText;
  readonly description: LocalText;
  readonly authors: readonly string[];
  readonly license: string;
  readonly engine: { readonly protocol: string | null; readonly server: string | null };
  /** True when the pack ships at least one module: installing it lets it run code on this server. */
  readonly runsCode: boolean;
  readonly modules: readonly { readonly id: string; readonly entry: string; readonly bytes: number; readonly sha256: string }[];
  readonly ruleSystems: readonly { readonly id: string; readonly extends: string | null }[];
  readonly skills: readonly {
    readonly id: string;
    readonly name: string;
    /** Gated tools the skill unlocks while enabled in a room. */
    readonly tools: readonly string[];
    /** The skill declares mature content: enabling it lifts the room's output filter. */
    readonly mature: boolean;
  }[];
  readonly cards: readonly {
    readonly path: string;
    readonly kind: "world" | "character";
    readonly name: string;
    /** World machinery the card carries; it reaches a room only through an admin's world import. */
    readonly machinery: {
      readonly variableDeclarations: number;
      readonly templates: number;
      readonly secretEntries: number;
      readonly moduleVariables: number;
      /** Hook scripts in the card: counted, never run. */
      readonly hooks: number;
    };
  }[];
  /**
   * Its panels: each one's id, kind, audience and the views it reads; a page's HTML file (a
   * page is code a rich client runs in its sandboxed frame, never the server).
   */
  readonly panels: readonly {
    readonly id: string;
    readonly kind: "template" | "page";
    readonly audience: "all" | "player" | "admin";
    readonly views: readonly string[];
    readonly page: { readonly path: string; readonly bytes: number; readonly sha256: string } | null;
  }[];
  readonly presentation: { readonly subjects: number; readonly cues: number; readonly generation: "allow" | "pack_only" } | null;
  readonly assets: { readonly count: number; readonly bytes: number };
  /** Every file the pack installs, `pack.yaml` included, and their bytes. */
  readonly files: { readonly count: number; readonly bytes: number };
  readonly ignored: readonly { readonly path: string; readonly reason: IgnoredReason }[];
}

export function trustCard(pack: Pack): TrustCard {
  const { manifest } = pack;
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    authors: manifest.authors,
    license: manifest.license,
    engine: manifest.engine,
    runsCode: pack.modules.length > 0,
    modules: pack.modules.map((module) => ({ id: module.id, entry: module.path, bytes: module.size, sha256: module.sha256 })),
    ruleSystems: pack.ruleSystems.map((system) => ({ id: system.id, extends: system.extends })),
    skills: pack.skills.map(({ skill }) => ({ id: skill.id, name: skill.name, tools: skill.allowedTools, mature: skill.contentRating === "mature" || skill.contentRating === "explicit" })),
    cards: pack.cards.map((card) => ({
      path: card.path,
      kind: card.kind,
      name: card.name,
      machinery: {
        variableDeclarations: card.machinery.variableDeclarations,
        templates: card.machinery.templateSpans,
        secretEntries: card.machinery.secretEntries,
        moduleVariables: card.machinery.moduleVariables,
        hooks: card.machinery.unsupportedHooks,
      },
    })),
    panels: pack.panels.map(({ spec, page }) => ({
      id: spec.id,
      kind: spec.kind,
      audience: spec.audience,
      views: spec.views.map((ref) => ref.view),
      page: page === null ? null : { path: page.path, bytes: page.size, sha256: page.sha256 },
    })),
    presentation: pack.presentation === null ? null : { subjects: pack.presentation.kit.subjects.length, cues: pack.presentation.kit.audio.length, generation: pack.presentation.kit.generation },
    assets: { count: pack.assets.length, bytes: pack.assets.reduce((sum, asset) => sum + asset.size, 0) },
    files: { count: pack.files.length, bytes: pack.files.reduce((sum, file) => sum + file.size, 0) },
    ignored: pack.ignored,
  };
}
