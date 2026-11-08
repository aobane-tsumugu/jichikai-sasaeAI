// 催しと文はこの試験のために作ったものです。写真のバイト列は既存の試しの資料を使います。
export const LINE_SHARING = {
  requests: [
    { title: "試しの外の工作体験会", text: "こんなイベントがあります！町内にシェアしたいです。", photoFirst: true },
    { title: "試しの外の音楽会", text: "この催しを町内の皆さんに知らせてほしいです。", photoFirst: false },
    { title: "試しの外の展示会", text: "この催しを区のお知らせに載せてほしいです。", photoFirst: true },
  ],
  photoOnlyTitle: "試しの写真だけの催し",
  manualTitle: "試しの手で入れた予定",
  dateText: "11月21日",
} as const;
