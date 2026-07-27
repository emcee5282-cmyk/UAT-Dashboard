// Renderer-agnostic column sizing engine (Enterprise Table V2, Sprint 3.1).
//
// This module describes each visible column's layout intent — minWidth,
// preferredWidth, grow — and nothing about how that intent becomes actual
// CSS. It must never import or reference Flex, Grid, or <table>/<colgroup>
// concepts. Settlement (app/stlm/page.tsx) is the only consumer today and
// is a Flex renderer; the point of keeping this file renderer-agnostic is
// so a future Grid or native-<table> renderer can consume the exact same
// ColumnLayout output via their own translation function, without this
// engine needing to know either exists.
//
// The actual space distribution (grow above preferred, shrink toward min,
// scroll past min) is deliberately left to the renderer/browser — e.g.
// Flex's own layout algorithm — not computed here. calculateColumnLayout
// is a pure projection of each column's sizing fields, not a pixel-width
// calculator; that keeps this engine honest about what it does today while
// still giving every renderer a single, common shape to consume.

export type ColumnSizing = {
  minWidth: number;
  preferredWidth: number;
  grow: number;
};

export type ColumnLayout<Id extends string = string> = { id: Id } & ColumnSizing;

export function calculateColumnLayout<Id extends string>(
  columns: ReadonlyArray<{ id: Id } & ColumnSizing>
): ColumnLayout<Id>[] {
  return columns.map(({ id, minWidth, preferredWidth, grow }) => ({ id, minWidth, preferredWidth, grow }));
}
