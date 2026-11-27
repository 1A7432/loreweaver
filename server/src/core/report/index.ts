// The session report: the model from the event log, the reveal material from the document
// projections, and the two renderings.
export { buildReport, MAX_DICE_ENTRIES, MAX_TRANSCRIPT_CHARS, scoreOf, type PlayerTally, type ReportDie, type ReportInput, type ReportLine, type ReportModel } from "./model.ts";
export { buildReveal, revealIsEmpty, type RevealModel } from "./reveal.ts";
export { escapeHtml, playedRange, renderMarkdown, renderPlain, renderReportHtml, renderReportText, type ReportPage } from "./html.ts";
