import type { DocumentKind, ItemKey, Scope } from "../../project/model";

/** 文書に載せる項目。content の空文字は、根拠がなく未確認であることを表す。 */
export interface DraftItem { key: ItemKey; content: string; source?: string; }

/** AI が作る文書本文と項目。確認事項は本文に作らず、役員への問いとして別に書く。 */
export interface DraftBody { text: string; items: DraftItem[]; }
export interface DraftPack { version: string; kind: DocumentKind; title: string; scope: Scope; instruction: string; }
