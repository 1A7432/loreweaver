// Every document type a room can hold, registered in one place.
//
// A type that is defined but not listed here cannot be stored, projected, reset or
// exported — and a reset refuses a room that holds a type nobody declared. The test
// beside this file's tests walks `core/` and fails when a type is missing from the list.
import { worldCardDocumentType } from "./card/index.ts";
import { characterDocumentType, claimableDocument, seatingDocument } from "./characters/index.ts";
import { campaignSummaryDocumentType, chronicleRecordDocumentType, plotThreadDocumentType } from "./chronicle/index.ts";
import { clockOwnerDocument, gameClockDocument, initiativeDocument } from "./clock/index.ts";
import { DocumentTypes } from "./documents/model.ts";
import { tableHabitsDocumentType } from "./habits/index.ts";
import { loreEntryDocumentType, loreOverlayDocumentType, loreTimersDocumentType } from "./lore/index.ts";
import { keeperNotesDocument, npcIntentsDocument, sceneDocument } from "./notes/index.ts";
import { npcDocument } from "./npcs/index.ts";
import { relationshipsDocumentType } from "./relationships/index.ts";
import type { RulePackRegistry } from "./rulepacks/index.ts";
import { moduleVariablesDocument, variableTreeDocument } from "./variables/index.ts";

/** The registry of a server whose rule systems are `packs`. */
export function allDocumentTypes(packs: RulePackRegistry): DocumentTypes {
  return new DocumentTypes()
    .register(characterDocumentType((id) => packs.get(id)?.sheet ?? null))
    .register(seatingDocument)
    .register(claimableDocument)
    .register(npcDocument)
    .register(sceneDocument)
    .register(keeperNotesDocument)
    .register(npcIntentsDocument)
    .register(gameClockDocument)
    .register(clockOwnerDocument)
    .register(initiativeDocument)
    .register(loreEntryDocumentType)
    .register(loreOverlayDocumentType)
    .register(loreTimersDocumentType)
    .register(worldCardDocumentType)
    .register(variableTreeDocument)
    .register(moduleVariablesDocument)
    .register(chronicleRecordDocumentType)
    .register(campaignSummaryDocumentType)
    .register(plotThreadDocumentType)
    .register(relationshipsDocumentType)
    .register(tableHabitsDocumentType);
}
