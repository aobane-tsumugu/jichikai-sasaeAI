import type { DocumentKind, ItemKey, Scope } from "../../project/model";

export interface DraftBody { text: string; items: { key: ItemKey; content: string; source?: string }[]; }
export interface DraftPack { version: string; kind: DocumentKind; title: string; scope: Scope; instruction: string; }
