/** Shared CSS grid column template so the header, display rows, and the inline
 * editor row all line up in the virtualized register. Leading 28px column is
 * the multi-select checkbox (the editor shows the Repeat picker in the status
 * column, so the widths must match across all three). */
export function registerTemplate(single: boolean): string {
  return single
    ? "28px 96px minmax(110px, 1.4fr) minmax(110px, 1fr) minmax(90px, 1fr) 120px 110px 40px"
    : "28px 96px 130px minmax(110px, 1.4fr) minmax(110px, 1fr) minmax(90px, 1fr) 120px 110px 40px";
}
