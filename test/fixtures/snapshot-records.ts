// 復元の試験だけに使う記録。名前、連絡先、認証に使う文字は全て架空。
// 区・役員・行事は呼ぶ側で作り、残りの保存対象を一つずつ持たせる。
export function snapshotRecords(wardId: string, projectId: string, accountId: string) {
  const id = (kind: string) => `${wardId}-${kind}`;
  const stamp = "2026-11-06T00:00:00.000Z";
  const expires = "2099-11-06T00:00:00.000Z";
  const row = (table: string, data: Record<string, string | number | null>) => ({ table, data: { ward_id: wardId, ...data } });
  const reading = JSON.stringify({ document_kind: "memo", summary: "架空の復元確認の資料", original_years: [{ original_id: id("original"), year: 2026 }],
    text_blocks: [{ original_id: id("original"), locator: "1行目", text: "架空の復旧先公民館" }], fields: [], tables: [], decisions: [], unreadable: [] });
  return [
    row("seats", { seat_id: id("seat"), title: "架空の書記" }),
    row("devices", { device_id: id("device"), account_id: accountId, token_hash: id("fictional-device-hash"), created_at: stamp, last_seen_at: stamp }),
    row("sign_in_links", { link_id: id("link"), account_id: accountId, purpose: "invite", token_hash: id("fictional-link-hash"), expires_at: expires, created_at: stamp, created_by_account_id: accountId }),
    row("login_attempts", { attempt_key: id("attempt-key"), attempt_id: id("attempt"), attempted_at: stamp }),
    row("provider_ward_contacts", { phone: "000-0000-0701", email: "restore@example.invalid" }),
    row("ward_settings", { key: "fixture.restore", value: "架空の復元確認", updated_by_account_id: accountId }),
    row("ops_ward_limits", { updated_at: stamp }),
    row("ward_ai", { created_at: stamp, updated_at: stamp }),
    row("ward_ai_route_flags", { updated_at: stamp }),
    row("jobs", { job_id: id("job"), project_id: projectId, via: "admin", account_id: accountId, status: "done", created_at: stamp, updated_at: stamp, read_at: stamp }),
    row("originals", { original_id: id("original"), job_id: id("job"), position: 1, kind: "text", content_hash: id("content-hash"), media_type: "text/plain", byte_size: 39,
      filename: "架空の復元確認.txt", r2_path: `originals/${id("original")}`, received_at: stamp }),
    row("readings", { reading_id: id("reading"), job_id: id("job"), source: "direct", pack_version: "fixture-restore@1", body: reading, created_at: stamp }),
    row("job_runs", { run_id: id("run"), job_id: id("job"), kind: "read", started_at: stamp, status: "ok" }),
    row("job_tool_calls", { call_id: id("call"), job_id: id("job"), tool: "get_reading", outcome: "ok", created_at: stamp }),
    row("paper_reading_slices", { job_id: id("job"), source_job_id: id("job"), body: reading, created_at: stamp }),
    row("intake_photo_checks", { original_id: id("original"), job_id: id("job"), readability: "readable", paper_kind: "memo", reason: "架空の確認" }),
    row("project_deadlines", { project_id: projectId, kind: "answer_due", due_on: "2099-11-07", updated_by_account_id: accountId }),
    row("rota_exemptions", { exemption_id: id("exemption"), household: "架空の世帯", district: "架空1班", reason: "架空の免除の理由", starts_on: "2026-01-01", ends_on: "2026-12-31", recorded_at: stamp, recorded_by_account_id: accountId }),
    row("rota_preparations", { preparation_id: id("preparation"), project_id: projectId, roster_json: JSON.stringify([{ household: "架空の世帯", district: "架空1班" }]), comparison_json: JSON.stringify({ sourceTitle: "架空の当番", sourceProjectId: null, year: 2025, hasOldRoster: false, added: ["架空の世帯"], removed: [], entries: [], ruleRecords: [] }), recorded_at: stamp, recorded_by_account_id: accountId }),
    row("rota_seat_changes", { change_id: id("seat-change"), account_id: accountId, name: "架空の書記", previous_title: "架空の会計", next_title: "架空の書記", recorded_at: stamp }),
    row("project_changes", { change_id: id("change"), project_id: projectId, kind: "row", target: "committee:架空の委員", status: "applied", dedupe_key: id("dedupe"),
      payload_hash: id("payload-hash"), payload: "{}", result: "{}", pack_version: "fixture-restore@1", created_by_account_id: accountId }),
    row("project_item_values", { value_id: id("value"), project_id: projectId, item_key: "place", scope: "current", content: "架空の復旧先公民館", source_kind: "person",
      source_ref: `person:${accountId}`, confidence: "high", change_id: id("change"), created_by_account_id: accountId }),
    row("project_rows", { row_id: id("row"), project_id: projectId, table_key: "committee", scope: "current", match_key: "架空の委員|書記",
      data: JSON.stringify({ name: "架空の委員", role: "書記", contact: "000-0000-0702" }), person_fields: '["contact","name","role"]',
      source_kind: "person", source_ref: `person:${accountId}`, confidence: "high", change_id: id("change"), created_by_account_id: accountId }),
    row("documents", { document_id: id("document"), project_id: projectId, kind: "announcement", title: "架空の復元案内", scope: "public" }),
    row("document_versions", { version_id: id("version"), document_id: id("document"), project_id: projectId, version_no: 1, scope: "public", body: '{"text":"架空の復元案内です。","items":[]}',
      based_on_state_version: 0, origin: "person", published_at: stamp, created_by_account_id: accountId, published_by_account_id: accountId }),
    row("project_questions", { question_id: id("question"), project_id: projectId, kind: "decide", text: "架空の会場を決めてください。", dedupe_key: id("question-key"), change_id: id("change") }),
    row("project_map_tasks", { task_id: id("task"), project_id: projectId, name: "架空の会場を予約する", task_key: "fixture-venue", seat_id: id("seat"), progress_change_id: id("change") }),
    row("publication_records", { publication_id: id("publication"), project_id: projectId, document_id: id("document"), version_id: id("version"), version_no: 1,
      line_status: "not_sent", published_at: stamp, published_by_account_id: accountId }),
    row("project_activity_pages", { project_id: projectId, updated_at: stamp, updated_by_account_id: accountId }),
    row("inquiry_records", { inquiry_id: id("inquiry"), received_at: stamp, kind: "inquiry", subject: "架空の問い合わせ", answer: "架空の返事", created_at: stamp, created_by_account_id: accountId }),
    row("city_request_details", { project_id: projectId, updated_at: stamp, updated_by_account_id: accountId }),
    row("ward_annual_budgets", { year: 2026, updated_at: stamp, updated_by_account_id: accountId }),
    row("ward_roster_entries", { roster_entry_id: id("roster"), roster_set_id: id("roster-set"), household: "架空の世帯", household_key: "架空の世帯", district: "架空1班" }),
    row("ward_roster_settings", { active_set_id: id("roster-set"), columns_json: "{}" }),
    row("project_answers", { answer_id: id("answer"), project_id: projectId, household: "架空の世帯", district: "架空1班", people_count: 3, source: "web", created_by_account_id: accountId,
      meeting_status: "proxy", proxy_name: "架空の議長" }),
    row("project_answer_submissions", { project_id: projectId, submission_id: id("submission"), answer_id: id("answer") }),
    row("project_help_offers", { offer_id: id("help"), project_id: projectId, name: "架空の手伝い役", times: "架空の午前", created_at: stamp }),
    row("project_spaces", { project_id: projectId, opened_at: stamp, updated_by_account_id: accountId }),
    row("project_space_invites", { invite_id: id("invite"), project_id: projectId, token_hash: id("fictional-invite-hash"), role: "member", expires_at: expires, created_by_account_id: accountId }),
    row("project_space_members", { member_id: id("member"), project_id: projectId, role: "leader", district: "架空1班", token_hash: id("fictional-member-hash"), expires_at: expires }),
    row("line_channels", { destination: id("destination") }),
    row("line_webhook_receipts", { event_id: id("event"), expires_at: expires }),
    row("line_inbox_items", { item_id: id("inbox"), event_id: id("inbox-event"), sender_id: id("sender"), original_kind: "text", original_text: "架空の連絡", received_at: stamp }),
    row("line_unrelated_daily_counts", { day: "2026-11-06", item_count: 1 }),
    row("line_group_notices", { group_id: id("group"), first_joined_at: stamp }),
    row("line_officer_digests", { day: "2026-11-06", claimed_at: stamp, recipients: 1, usage_before: 0, inquiry_count: 1 }),
    row("line_photo_batches", { batch_id: id("batch"), destination: id("destination"), source_type: "user", source_id: id("sender"), sender_id: id("sender"), created_at: stamp, last_received_at: stamp }),
    row("line_photo_items", { batch_id: id("batch"), job_id: id("job"), message_id: id("message") }),
    row("line_clarifications", { clarification_id: id("clarification"), batch_id: id("batch"), job_id: id("job"), original_id: id("original"), topic: "year", text: "架空の年の質問", question_id: id("question") }),
    row("line_clarification_answers", { event_id: id("clarification-event"), clarification_id: id("clarification"), job_id: id("job"), answer_text: "2026年です。", sender_label: "架空の役員" }),
    row("line_photo_sources", { destination: id("destination"), source_type: "group", source_id: id("group"), project_id: projectId }),
    row("project_close_map", { project_id: projectId, task_id: id("task"), name: "架空の会場を予約する", progress: "done", updated_at: stamp, updated_by_account_id: accountId }),
    row("project_close_reports", { project_id: projectId, scope: "public", body: "架空の報告", updated_at: stamp, updated_by_account_id: accountId }),
    row("ops_deletion_queue", { queue_id: id("queue"), target_type: "job", target_id: id("job"), requested_at: stamp }),
    row("ops_deletion_marks", { mark_id: id("mark"), scope: "record", deleted_at: stamp }),
  ];
}

export function providerSnapshotRecords() {
  const ward_id = "provider-contacts", contact_id = "fixture-restore-contact", created_at = "2026-11-06T00:00:00.000Z";
  return [
    { table: "provider_contacts", data: { ward_id, contact_id, receipt: "000000000001", token_hash: "fictional-contact-hash", kind: "access", ward_name: "架空の復元確認区", name: "架空の依頼役", reach: "restore@example.invalid", created_at } },
    { table: "provider_contact_messages", data: { ward_id, contact_id, message_id: "fixture-restore-message", sender: "person", body: "架空の問い合わせの本文です。", created_at } },
    { table: "provider_contact_throttle", data: { ward_id, identity_hash: "fictional-contact-hash", window_start: 0, sends: 1 } },
  ];
}
