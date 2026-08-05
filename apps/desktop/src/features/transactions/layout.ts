/** Shared CSS grid column template so the header, display rows, and the inline
 * editor row all line up in the virtualized register. */
export function registerTemplate(single: boolean): string {
  return single
    ? "96px minmax(110px, 1.4fr) minmax(110px, 1fr) minmax(90px, 1fr) 120px 96px 40px"
    : "96px 130px minmax(110px, 1.4fr) minmax(110px, 1fr) minmax(90px, 1fr) 120px 96px 40px";
}
