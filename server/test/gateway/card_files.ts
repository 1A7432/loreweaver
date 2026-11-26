// Card files as a member uploads them: a SillyTavern card as JSON or embedded in a PNG, one
// stuffed with world machinery, and a helper that brings bytes in through `Uploads` (the
// gateway side of the byte channel) without a transport.
import { createHash } from "node:crypto";

import type { Role, UploadPurpose } from "loreweaver-protocol/v3";

import type { Uploads } from "../../src/gateway/uploads.ts";
import type { MediaRecord } from "../../src/infra/media/index.ts";

const encoder = new TextEncoder();

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A marker in every machinery field: none may survive a character import (nor reach a player). */
export const MK = {
  plainLore: "MK-PLAINLORE",
  secret: "MK-SECRET",
  initvar: "MK_INITVAR",
  ejs: "MK-EJS",
  system: "MK-SYSTEM",
  post: "MK-POSTHIST",
  hook: "MK-HOOK",
  scenario: "MK-SCENARIO",
  greeting: "MK-GREETING",
} as const;

export function plainCard(name: string): Record<string, unknown> {
  return { spec: "chara_card_v2", spec_version: "2.0", data: { name, description: `${name} is a sailor.`, personality: "Calm." } };
}

/** A world card: lore (one entry secret), a variable declaration, directives, an opening, a hook. */
export function worldCard(name = "Drowned City"): Record<string, unknown> {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name,
      description: `A city under the sea.<% var s = "${MK.ejs}"; %>`,
      personality: "Patient.",
      scenario: `${MK.scenario}: the tide is out`,
      first_mes: `${MK.greeting} — the bells ring.`,
      system_prompt: `${MK.system} You are {{char}}.`,
      post_history_instructions: `${MK.post} Keep {{user}} in view.`,
      character_book: {
        entries: [
          { keys: ["harbor"], content: `${MK.plainLore} The harbor is older than the city.`, comment: "Harbor" },
          { keys: ["vault"], content: `${MK.secret} The vault key is under the altar.`, comment: "Vault", secret: true },
          { keys: [], content: `\`\`\`yaml\n${MK.initvar}:\n  depth: 3\n\`\`\``, comment: "[InitVar] state" },
        ],
      },
      extensions: { loreweaver_hooks: [{ event: "turn_start", code: `/* ${MK.hook} */ return null;` }] },
    },
  };
}

export function jsonFile(card: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(card));
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(encoder.encode(type), 4);
  out.set(data, 8);
  // CRC left zero: the card reader does not check it.
  return out;
}

/** A PNG with the card in a `chara` tEXt chunk, base64 as SillyTavern writes it. */
export function pngFile(card: unknown): Uint8Array {
  const text = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", new Uint8Array(13)),
    chunk("tEXt", Uint8Array.from([...encoder.encode("chara"), 0, ...encoder.encode(text)])),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Offer and send `bytes` as `member` through `uploads`; the stored record, or the refusal's code. */
export async function upload(
  uploads: Uploads,
  room: string,
  member: { readonly id: string; readonly role: Role },
  bytes: Uint8Array,
  mime: string,
  purpose: UploadPurpose = "import",
  name = "card",
): Promise<MediaRecord | string> {
  const offered = uploads.offer(room, member, { name, mime, size: bytes.length, sha256: sha256(bytes), purpose });
  if (!offered.ok) return offered.code;
  if (offered.kind === "existing") return offered.record;
  const received = await uploads.receive(room, member, offered.uploadId, bytes);
  return received.ok ? received.record : received.code;
}
