import { newId, nowIso } from "../core/ids";

export type SpaceRole = "member" | "leader";
export interface SpaceCredential {
  token: string;
  role: SpaceRole;
  district: string | null;
  projectId: string;
}

export function makeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function passphraseHash(passphrase: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const saltBytes = new Uint8Array(salt.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? []);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: 100_000 }, key, 256);
  return Array.from(new Uint8Array(bits), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function openSpace(db: D1Database, wardId: string, projectId: string, passphrase: string, accountId: string): Promise<void> {
  const salt = makeToken();
  const hash = await passphraseHash(passphrase, salt);
  const now = nowIso();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO project_spaces (ward_id, project_id, opened_at, closed_at, passphrase_salt, passphrase_hash, updated_by_account_id)
       SELECT ?, p.project_id, ?, NULL, ?, ?, ? FROM projects p WHERE p.ward_id = ? AND p.project_id = ?
       ON CONFLICT (ward_id, project_id) DO UPDATE SET opened_at = excluded.opened_at, closed_at = NULL,
         passphrase_salt = excluded.passphrase_salt, passphrase_hash = excluded.passphrase_hash, updated_by_account_id = excluded.updated_by_account_id`,
    ).bind(wardId, now, salt, hash, accountId, wardId, projectId),
    db.prepare("UPDATE project_space_invites SET revoked_at = ? WHERE ward_id = ? AND project_id = ? AND revoked_at IS NULL")
      .bind(now, wardId, projectId),
    db.prepare("UPDATE project_space_members SET revoked_at = ? WHERE ward_id = ? AND project_id = ? AND revoked_at IS NULL")
      .bind(now, wardId, projectId),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) throw new Error("プロジェクトが見つかりません。");
}

export async function closeSpace(db: D1Database, wardId: string, projectId: string, accountId: string): Promise<void> {
  const now = nowIso();
  await db.batch([
    db.prepare("UPDATE project_spaces SET closed_at = ?, updated_by_account_id = ? WHERE ward_id = ? AND project_id = ?")
      .bind(now, accountId, wardId, projectId),
    db.prepare("UPDATE project_space_invites SET revoked_at = ? WHERE ward_id = ? AND project_id = ? AND revoked_at IS NULL")
      .bind(now, wardId, projectId),
    db.prepare("UPDATE project_space_members SET revoked_at = ? WHERE ward_id = ? AND project_id = ? AND revoked_at IS NULL")
      .bind(now, wardId, projectId),
  ]);
}

export async function getSpace(db: D1Database, wardId: string, projectId: string) {
  return db.prepare("SELECT opened_at, closed_at, passphrase_hash FROM project_spaces WHERE ward_id = ? AND project_id = ?")
    .bind(wardId, projectId).first<{ opened_at: string; closed_at: string | null; passphrase_hash: string | null }>();
}

export async function verifyPassphrase(db: D1Database, wardId: string, projectId: string, passphrase: string): Promise<boolean> {
  const row = await db.prepare("SELECT passphrase_salt, passphrase_hash FROM project_spaces WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
    .bind(wardId, projectId).first<{ passphrase_salt: string | null; passphrase_hash: string | null }>();
  if (!row?.passphrase_salt || !row.passphrase_hash) return false;
  return (await passphraseHash(passphrase, row.passphrase_salt)) === row.passphrase_hash;
}

export async function createInvite(
  db: D1Database,
  wardId: string,
  projectId: string,
  role: SpaceRole,
  district: string | null,
  accountId: string,
  directMember = false,
): Promise<string> {
  const token = makeToken();
  const hashed = await tokenHash(token);
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  if (directMember) {
    const result = await db.prepare(
      `INSERT INTO project_space_members (member_id, ward_id, project_id, role, district, token_hash, expires_at)
       SELECT ?, ?, p.project_id, ?, ?, ?, ? FROM projects p JOIN project_spaces s ON s.ward_id = p.ward_id AND s.project_id = p.project_id AND s.closed_at IS NULL
       WHERE p.ward_id = ? AND p.project_id = ?`,
    ).bind(newId(), wardId, role, district, hashed, expires, wardId, projectId).run();
    if ((result.meta.changes ?? 0) === 0) throw new Error("空間を開いてから作ってください。");
  } else {
    const result = await db.prepare(
      `INSERT INTO project_space_invites (invite_id, ward_id, project_id, token_hash, district, role, expires_at, created_by_account_id)
       SELECT ?, ?, p.project_id, ?, ?, ?, ?, ? FROM projects p JOIN project_spaces s ON s.ward_id = p.ward_id AND s.project_id = p.project_id AND s.closed_at IS NULL
       WHERE p.ward_id = ? AND p.project_id = ?`,
    ).bind(newId(), wardId, hashed, district, role, expires, accountId, wardId, projectId).run();
    if ((result.meta.changes ?? 0) === 0) throw new Error("空間を開いてから作ってください。");
  }
  return token;
}

export async function exchangeInvite(db: D1Database, wardId: string, projectId: string, token: string): Promise<SpaceCredential | null> {
  const hashed = await tokenHash(token);
  const row = await db.prepare(
    `SELECT i.invite_id, i.role, i.district FROM project_space_invites i
     JOIN project_spaces s ON s.ward_id = i.ward_id AND s.project_id = i.project_id
     WHERE i.ward_id = ? AND i.project_id = ? AND i.token_hash = ? AND i.used_at IS NULL AND i.revoked_at IS NULL
       AND i.expires_at > ? AND s.closed_at IS NULL`,
  ).bind(wardId, projectId, hashed, nowIso()).first<{ invite_id: string; role: SpaceRole; district: string | null }>();
  if (!row) return null;
  const memberToken = makeToken();
  const memberHash = await tokenHash(memberToken);
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const now = nowIso();
  const used = await db.prepare("UPDATE project_space_invites SET used_at = ? WHERE ward_id = ? AND invite_id = ? AND used_at IS NULL AND revoked_at IS NULL")
    .bind(now, wardId, row.invite_id).run();
  if ((used.meta.changes ?? 0) === 0) return null;
  await db.prepare("INSERT INTO project_space_members (member_id, ward_id, project_id, role, district, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(newId(), wardId, projectId, row.role, row.district, memberHash, expires).run();
  return { token: memberToken, role: row.role, district: row.district, projectId };
}

export async function findMember(db: D1Database, wardId: string, projectId: string, token: string): Promise<SpaceCredential | null> {
  const hash = await tokenHash(token);
  const row = await db.prepare(
    `SELECT m.role, m.district FROM project_space_members m JOIN project_spaces s
     ON s.ward_id = m.ward_id AND s.project_id = m.project_id
     JOIN projects p ON p.ward_id = m.ward_id AND p.project_id = m.project_id
     WHERE m.ward_id = ? AND m.project_id = ? AND m.token_hash = ? AND m.revoked_at IS NULL AND m.expires_at > ? AND s.closed_at IS NULL AND p.closed_at IS NULL`,
  ).bind(wardId, projectId, hash, nowIso()).first<{ role: SpaceRole; district: string | null }>();
  return row ? { token, role: row.role, district: row.district, projectId } : null;
}

export async function accessByPassphrase(db: D1Database, wardId: string, projectId: string, token: string): Promise<SpaceCredential | null> {
  const hash = await tokenHash(token);
  const row = await db.prepare(
    `SELECT m.role, m.district FROM project_space_members m JOIN project_spaces s ON s.ward_id = m.ward_id AND s.project_id = m.project_id
     WHERE m.ward_id = ? AND m.project_id = ? AND m.token_hash = ? AND m.revoked_at IS NULL AND m.expires_at > ? AND s.closed_at IS NULL`,
  ).bind(wardId, projectId, hash, nowIso()).first<{ role: SpaceRole; district: string | null }>();
  return row ? { token, role: row.role, district: row.district, projectId } : null;
}

export async function enterWithPassphrase(db: D1Database, wardId: string, projectId: string, passphrase: string): Promise<SpaceCredential | null> {
  if (!(await verifyPassphrase(db, wardId, projectId, passphrase))) return null;
  const token = makeToken();
  const hash = await tokenHash(token);
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(
    `INSERT INTO project_space_members (member_id, ward_id, project_id, role, district, token_hash, expires_at)
     VALUES (?, ?, ?, 'member', NULL, ?, ?)`,
  ).bind(newId(), wardId, projectId, hash, expires).run();
  return { token, role: "member", district: null, projectId };
}

export async function getSpaceMaterials(db: D1Database, wardId: string, projectId: string, district: string | null) {
  const [project, rows, answers, docs, originals] = await Promise.all([
    db.prepare("SELECT title FROM projects WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ title: string }>(),
    db.prepare("SELECT table_key, data FROM project_rows WHERE ward_id = ? AND project_id = ? AND scope = 'current' AND removed_at IS NULL AND table_key IN ('sponsors', 'duties', 'layout') ORDER BY table_key, created_at")
      .bind(wardId, projectId).all<{ table_key: string; data: string }>(),
    district === null
      ? db.prepare("SELECT district, household, people_count FROM project_answers WHERE ward_id = ? AND project_id = ? ORDER BY district, household").bind(wardId, projectId).all<{ district: string; household: string; people_count: number }>()
      : db.prepare("SELECT district, household, people_count FROM project_answers WHERE ward_id = ? AND project_id = ? AND district = ? ORDER BY household").bind(wardId, projectId, district).all<{ district: string; household: string; people_count: number }>(),
    db.prepare(
      `SELECT d.document_id, d.title, v.body FROM documents d JOIN document_versions v
       ON v.ward_id = d.ward_id AND v.document_id = d.document_id AND v.version_no =
        (SELECT MAX(v2.version_no) FROM document_versions v2 WHERE v2.ward_id = d.ward_id AND v2.document_id = d.document_id)
       WHERE d.ward_id = ? AND d.project_id = ? AND d.scope = 'space' AND v.scope = 'space'
       ORDER BY d.created_at`,
    ).bind(wardId, projectId).all<{ document_id: string; title: string; body: string }>(),
    db.prepare(
      `SELECT o.original_id, o.filename, o.media_type FROM originals o JOIN jobs j
       ON j.ward_id = o.ward_id AND j.job_id = o.job_id
       WHERE o.ward_id = ? AND j.project_id = ? AND j.via = 'space' AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL
       ORDER BY o.received_at, o.position`,
    ).bind(wardId, projectId).all<{ original_id: string; filename: string; media_type: string }>(),
  ]);
  const items = rows.results.map((row) => {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(row.data) as Record<string, unknown>; } catch { data = {}; }
    if (row.table_key === "sponsors") {
      delete data.amount;
      delete data.lastYearAmount;
    }
    return { kind: row.table_key, data };
  });
  return { title: project?.title ?? "", items, attendance: answers.results, documents: docs.results, originals: originals.results };
}
