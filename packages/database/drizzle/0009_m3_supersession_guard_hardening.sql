-- M3 hardening: close the single-statement supersession bypass of 0008's claims_supersession_guard.
--
-- 0008 returned NEW when the predecessor row was not found, on the assumption that the composite
-- foreign key reports a missing predecessor. That is wrong for a multi-row statement: foreign keys
-- are checked at the END of the statement, after every row exists, while this BEFORE ROW trigger
-- runs per row. A successor listed BEFORE its predecessor in one INSERT (or a data-modifying CTE)
-- therefore skipped the verification-transition check, and mutual or longer forward references
-- (A -> B, B -> A) formed supersession cycles that the end-of-statement foreign key accepted.
--
-- New rule: a claim may supersede only a predecessor that is ALREADY VISIBLE to this trigger, in the
-- same project. A forward reference is never valid claim history, so the guard fails closed instead
-- of deferring to the foreign key. Together with single-successor (UNIQUE supersedes_id) and
-- immutability (no UPDATE), "references only an existing row" is what makes a cycle impossible:
-- every edge points to a row that existed before the referencing row, so edges strictly go back in
-- insertion order.
--
-- Visibility: a row inserted by an EARLIER statement or committed transaction is always visible.
-- Within a single INSERT ... VALUES, PostgreSQL inserts rows in the written order and a VOLATILE
-- plpgsql trigger sees the rows already inserted by the same command, so a predecessor-first chain
-- is accepted; a successor-first chain, or siblings of one data-modifying CTE (which cannot see each
-- other), are rejected. The application (EvidenceGraphStore) inserts claims one statement at a time
-- and never relies on this.
--
-- Self-supersession (supersedes_id = id) is left to the existing CHECK claims_not_self_superseding,
-- which reports it cleanly; every other missing predecessor raises here.
CREATE OR REPLACE FUNCTION "claims_supersession_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_old text;
  v_old_tier integer;
  v_new_tier integer;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.supersedes_id = NEW.id THEN
    RETURN NEW; -- the claims_not_self_superseding CHECK rejects it
  END IF;
  SELECT verification_level INTO v_old FROM "claims"
    WHERE id = NEW.supersedes_id AND project_id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a claim can only supersede an existing claim of the same project; forward references are not valid claim history'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  v_old_tier := "evidence_graph_verification_tier"(v_old);
  v_new_tier := "evidence_graph_verification_tier"(NEW.verification_level);
  IF v_old_tier IS NOT NULL AND v_new_tier IS NOT NULL AND v_new_tier < v_old_tier THEN
    RAISE EXCEPTION 'a claim cannot move from % to % when superseded; verification never silently drops', v_old, NEW.verification_level
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
