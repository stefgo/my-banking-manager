import { GRID_COLUMNS, clampCardSize, type CardType } from "@mbm/shared";

// Geometry of the overview grid; `.card-grid` in app.css uses the same values.
export const ROW_PX = 56;
export const GAP_PX = 20;
/**
 * The grid's actual rows are this fine; each card spans as many as its height needs, so the next
 * card moves up under whichever card ends first. 56 + 20 px is exactly 19 of them.
 */
export const UNIT_PX = 4;
/** From this viewport width on the grid has all 12 columns (and cards can be resized). */
export const FULL_GRID_QUERY = "(min-width: 1121px)";

/** Columns a card spans in the medium grid of 6: wide cards the whole row, the rest half of it. */
export const spanOfSix = (width: number) => (width >= 6 ? 6 : 3);

/** Pixel height of a card that is `rows` grid rows high (the gaps between its rows included). */
export const rowsToPx = (rows: number) => rows * ROW_PX + (rows - 1) * GAP_PX;

/** Fine grid rows a card of this pixel height spans, with the gap below it. */
export const unitSpan = (px: number) => Math.max(1, Math.ceil((px + GAP_PX - 0.5) / UNIT_PX));

/** Grid rows a card of this pixel height takes, rounded to the nearest. */
export const pxToRows = (px: number) => Math.max(1, Math.round((px + GAP_PX) / (ROW_PX + GAP_PX)));

export const sizeLabel = (width: number, height: number | null) => `${width} × ${height ?? "auto"}`;

/**
 * New size while dragging a card's resize handle by `dx`/`dy` pixels in a grid `gridPx` wide.
 * An auto-height card keeps following its content until it is dragged by half a row vertically.
 */
export function dragSize(
    type: CardType,
    start: { width: number; height: number | null; measuredRows: number },
    dx: number,
    dy: number,
    gridPx: number,
): { width: number; height: number | null } {
    const unitX = (gridPx + GAP_PX) / GRID_COLUMNS;
    const unitY = ROW_PX + GAP_PX;
    const width = start.width + Math.round(dx / unitX);
    const fixed = start.height !== null || Math.abs(dy) >= unitY / 2;
    const height = fixed ? (start.height ?? start.measuredRows) + Math.round(dy / unitY) : null;
    return clampCardSize(type, width, height);
}
