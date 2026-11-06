-- U16: 同じLINEとメールを一人に限る規則を外す。過去の記録と列は残す。
DROP INDEX sign_in_subject_active;
CREATE INDEX sign_in_subject_lookup ON sign_in_methods (ward_id, kind, subject) WHERE removed_at IS NULL;
