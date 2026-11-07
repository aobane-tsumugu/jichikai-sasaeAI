// 催しと文はすべて架空です。写真のバイト列は既存の架空資料を使います。
export const LINE_SHARING = {
  requests: [
    { title: "架空の外の工作体験会", text: "こんなイベントがあります！町内にシェアしたいです。", photoFirst: true },
    { title: "架空の外の音楽会", text: "この催しを町内の皆さんに知らせてほしいです。", photoFirst: false },
    { title: "架空の外の展示会", text: "この催しを区のお知らせに載せてほしいです。", photoFirst: true },
  ],
  photoOnlyTitle: "架空の写真だけの催し",
  manualTitle: "架空の手で入れた予定",
  dateText: "11月21日",
} as const;
