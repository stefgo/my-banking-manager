import type { Info, InfoAttribute } from "@mbm/shared";

/** The two columns that hold the own information of an account, a group or a category. */
export interface InfoColumns {
    info_attributes: string;
    info_notes: string;
}

export const readInfo = (r: InfoColumns): Info => ({ attributes: JSON.parse(r.info_attributes) as InfoAttribute[], notes: r.info_notes });

/** Column values for an update: the new information, else what the row has. */
export const infoValues = (row: InfoColumns, info: Info | undefined): [string, string] =>
    info ? [JSON.stringify(info.attributes.map(({ key, value }) => ({ key, value }))), info.notes] : [row.info_attributes, row.info_notes];
