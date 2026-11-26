// `generate_image` (gated: the image-gen skill unlocks it). The image lane — the provider
// call, storage, the room's image budget — is injected; this tool only asks it and turns
// the stored image into the table's `media` event.
import { param } from "./params.ts";
import { refuse } from "./shared.ts";
import { defineTool, type ImageKind, type ToolResult } from "./types.ts";

const KINDS: ReadonlySet<string> = new Set<ImageKind>(["scene", "portrait", "item"]);

const IMAGE_FAILURES: Readonly<Record<string, string>> = {
  not_configured: "Image generation is not configured. Ask the room admin to configure an image provider first.",
  rate_limited: "Image generation limit reached for this room. Try again later.",
};

export const generateImageTool = defineTool({
  name: "generate_image",
  description: "Generate one player-visible image handout and send it to the room.",
  params: {
    prompt: param.string("Player-safe image prompt sent to the external image provider."),
    kind: param.string("scene, portrait, or item. Used only for the generated file name and reply text.").or("scene"),
    caption: param.string("Optional player-visible caption for the Keeper to narrate after sending.").or(""),
  },
  flags: { gated: true },
  suspends: "network",
  async run(context, args, turn): Promise<ToolResult> {
    const generate = turn.deps.generateImage;
    if (generate === undefined) return refuse("not_configured", IMAGE_FAILURES.not_configured as string);
    const kind = args.kind.trim().toLowerCase();
    const result = await generate({
      room: context.room,
      locale: context.locale,
      prompt: args.prompt,
      kind: KINDS.has(kind) ? (kind as ImageKind) : "scene",
      caption: args.caption.trim(),
    });
    if (!result.ok) {
      const known = IMAGE_FAILURES[result.code];
      return known === undefined ? { status: "failed", code: result.code, text: `Image generation failed (${result.code}).` } : refuse(result.code, known);
    }
    const caption = args.caption.trim() === "" ? "" : ` Caption to narrate: ${args.caption.trim()}`;
    return {
      text: `Image sent: ${result.media.name} (${result.media.hash.slice(0, 12)}).${caption}`,
      events: [{ kind: "media", data: result.media }],
    };
  },
});
