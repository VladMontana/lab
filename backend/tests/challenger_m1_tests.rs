//! Adversarial stress test suite and empirical challenge oracles for Milestone 1.
//!
//! Specifically stress-tests:
//! 1. Foreign key CASCADE propagation across pages -> publications, assets, page_public_assets
//! 2. Foreign key CASCADE propagation from assets -> page_public_assets
//! 3. Foreign key CASCADE propagation from admin -> sessions
//! 4. Foreign key RESTRICT enforcement on subjects -> pages and subjects -> publications
//! 5. Foreign key orphan prevention on all relational tables
//! 6. Asset kind CHECK constraint boundary & fuzz testing
//! 7. Unique admin username constraint enforcement on insert and update
//! 8. SQLite WAL mode, synchronous=NORMAL, foreign_keys=ON, and busy_timeout=5000ms
//! 9. Foreign keys enforcement across every connection in the pool
//! 10. Concurrency stress: 20 simultaneous workers (10 readers, 10 writers) in WAL mode
//! 11. Concurrency queueing: busy_timeout tolerates held write transactions without failing

use backend::db::{init_db, init_test_db};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::time::sleep;

// ============================================================================
// 1. FOREIGN KEY CASCADE TESTS
// ============================================================================

#[tokio::test]
async fn test_fk_cascade_page_deletion_cleans_dependent_tables() {
    let pool = init_test_db().await.expect("Failed to initialize test db");

    // Setup: 2 subjects, 3 pages (Page 1 & 2 in Subject 1, Page 3 in Subject 2)
    sqlx::query("INSERT INTO subjects (id, name, position) VALUES ('sub-c1', 'Math', 1), ('sub-c2', 'Physics', 2)")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO pages (id, draft_subject_id, draft_title, draft_markdown, revision) VALUES 
         ('p-1', 'sub-c1', 'Lab 1', 'Content 1', 1),
         ('p-2', 'sub-c1', 'Lab 2', 'Content 2', 1),
         ('p-3', 'sub-c2', 'Lab 3', 'Content 3', 1)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Populate publications for p-1, p-2, p-3
    sqlx::query(
        "INSERT INTO publications (page_id, subject_id, title, markdown, published_revision) VALUES
         ('p-1', 'sub-c1', 'Pub 1', 'M 1', 1),
         ('p-2', 'sub-c1', 'Pub 2', 'M 2', 1),
         ('p-3', 'sub-c2', 'Pub 3', 'M 3', 1)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Populate assets for p-1 and p-2
    sqlx::query(
        "INSERT INTO assets (id, page_id, stored_name, original_name, mime, byte_size, kind) VALUES
         ('a-1', 'p-1', 's1', 'f1.png', 'image/png', 10, 'image'),
         ('a-2', 'p-1', 's2', 'f2.pdf', 'application/pdf', 20, 'attachment'),
         ('a-3', 'p-2', 's3', 'f3.png', 'image/png', 30, 'image')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Populate page_public_assets
    sqlx::query(
        "INSERT INTO page_public_assets (page_id, asset_id) VALUES
         ('p-1', 'a-1'),
         ('p-1', 'a-2'),
         ('p-2', 'a-3')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Challenge Action: Delete p-1
    sqlx::query("DELETE FROM pages WHERE id = 'p-1'")
        .execute(&pool)
        .await
        .expect("Deleting page p-1 should succeed");

    // Oracle Assertions:
    // 1. publications for p-1 must be 0; p-2, p-3 must remain
    let p1_pubs: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM publications WHERE page_id = 'p-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        p1_pubs, 0,
        "Publications for deleted page p-1 must be CASCADE deleted"
    );

    let remaining_pubs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM publications")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining_pubs, 2,
        "Publications for p-2 and p-3 must remain intact"
    );

    // 2. assets for p-1 must be 0; a-3 must remain
    let p1_assets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assets WHERE page_id = 'p-1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        p1_assets, 0,
        "Assets for deleted page p-1 must be CASCADE deleted"
    );

    let a3_exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assets WHERE id = 'a-3'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(a3_exists, 1, "Asset a-3 on p-2 must not be affected");

    // 3. page_public_assets for p-1 must be 0; (p-2, a-3) must remain
    let p1_ppa: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_public_assets WHERE page_id = 'p-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        p1_ppa, 0,
        "page_public_assets for deleted page p-1 must be CASCADE deleted"
    );

    let p2_ppa: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_public_assets WHERE page_id = 'p-2'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(p2_ppa, 1, "page_public_assets for p-2 must remain");
}

#[tokio::test]
async fn test_fk_cascade_asset_deletion_cleans_junction_table() {
    let pool = init_test_db().await.expect("Failed to initialize test db");

    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-ast', 'Biology')")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title) VALUES ('p-ast', 'sub-ast', 'Genetics')")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO assets (id, page_id, stored_name, original_name, mime, byte_size, kind) VALUES
         ('ast-single', 'p-ast', 'dna.png', 'dna.png', 'image/png', 500, 'image')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO page_public_assets (page_id, asset_id) VALUES ('p-ast', 'ast-single')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Challenge Action: Delete ONLY the asset
    sqlx::query("DELETE FROM assets WHERE id = 'ast-single'")
        .execute(&pool)
        .await
        .expect("Deleting asset should succeed");

    // Oracle Assertion: page_public_assets row must be CASCADE deleted by asset_id FK
    let ppa_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_public_assets WHERE asset_id = 'ast-single'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        ppa_count, 0,
        "Deleting asset must cascade delete its entry in page_public_assets"
    );

    // Page and subject must still exist
    let page_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE id = 'p-ast'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        page_count, 1,
        "Page must remain intact when individual asset is deleted"
    );
}

#[tokio::test]
async fn test_fk_cascade_admin_deletion_cleans_sessions() {
    let pool = init_test_db().await.expect("Failed to initialize test db");

    // Insert 2 admins
    sqlx::query("INSERT INTO admin (id, username, password_hash) VALUES (10, 'admin1', 'hash1'), (20, 'admin2', 'hash2')")
        .execute(&pool)
        .await
        .unwrap();

    // Insert sessions: 3 for admin 10, 2 for admin 20
    sqlx::query(
        "INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES
         ('tok-1', 10, '2099-01-01'),
         ('tok-2', 10, '2099-01-01'),
         ('tok-3', 10, '2099-01-01'),
         ('tok-4', 20, '2099-01-01'),
         ('tok-5', 20, '2099-01-01')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Challenge Action: Delete admin 10
    sqlx::query("DELETE FROM admin WHERE id = 10")
        .execute(&pool)
        .await
        .expect("Deleting admin 10 should succeed");

    // Oracle Assertion:
    let admin10_sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE admin_id = 10")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        admin10_sessions, 0,
        "All sessions for admin 10 must be CASCADE deleted"
    );

    let admin20_sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE admin_id = 20")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        admin20_sessions, 2,
        "Sessions for admin 20 must remain intact"
    );
}

// ============================================================================
// 2. FOREIGN KEY RESTRICT TESTS
// ============================================================================

#[tokio::test]
async fn test_fk_restrict_deleting_subject_with_draft_pages_fails() {
    let pool = init_test_db().await.expect("Failed to initialize test db");

    sqlx::query(
        "INSERT INTO subjects (id, name) VALUES ('sub-r1', 'Chemistry'), ('sub-r2', 'History')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title) VALUES ('p-r1', 'sub-r1', 'Organic Lab')")
        .execute(&pool)
        .await
        .unwrap();

    // Challenge Action 1: Try deleting subject 'sub-r1' which has an active page
    let res = sqlx::query("DELETE FROM subjects WHERE id = 'sub-r1'")
        .execute(&pool)
        .await;

    assert!(
        res.is_err(),
        "Deleting subject with pages must fail with FOREIGN KEY RESTRICT constraint"
    );
    let err_str = res.unwrap_err().to_string();
    assert!(
        err_str.to_lowercase().contains("foreign key")
            || err_str.to_lowercase().contains("constraint"),
        "Error message should mention foreign key constraint: {err_str}"
    );

    // Challenge Action 2: Deleting 'sub-r2' which has NO pages should succeed
    let res2 = sqlx::query("DELETE FROM subjects WHERE id = 'sub-r2'")
        .execute(&pool)
        .await;
    assert!(
        res2.is_ok(),
        "Deleting subject with zero pages must succeed"
    );

    // Challenge Action 3: Reassign page to another subject, then delete sub-r1
    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-r3', 'New Subject')")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("UPDATE pages SET draft_subject_id = 'sub-r3' WHERE id = 'p-r1'")
        .execute(&pool)
        .await
        .unwrap();

    let res3 = sqlx::query("DELETE FROM subjects WHERE id = 'sub-r1'")
        .execute(&pool)
        .await;
    assert!(
        res3.is_ok(),
        "After reassigning pages away, deleting original subject must succeed"
    );
}

#[tokio::test]
async fn test_fk_restrict_deleting_subject_with_publications_fails() {
    let pool = init_test_db().await.expect("Failed to initialize test db");

    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-pub1', 'Subject A'), ('sub-pub2', 'Subject B')")
        .execute(&pool)
        .await
        .unwrap();

    // Page draft is in Subject B, but publication snapshot was published under Subject A
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title) VALUES ('p-pub1', 'sub-pub2', 'Published Article')")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO publications (page_id, subject_id, title, markdown, published_revision) VALUES
         ('p-pub1', 'sub-pub1', 'Published Article', '# Content', 1)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Challenge Action: Attempt to delete Subject A (which has publication referencing it)
    let res = sqlx::query("DELETE FROM subjects WHERE id = 'sub-pub1'")
        .execute(&pool)
        .await;

    assert!(
        res.is_err(),
        "Deleting subject referenced by a publication must fail under RESTRICT"
    );
}

// ============================================================================
// 3. FOREIGN KEY ORPHAN INSERTION TESTS
// ============================================================================

#[tokio::test]
async fn test_fk_orphan_insertions_are_strictly_rejected() {
    let pool = init_test_db().await.expect("Failed to initialize test db");

    // 1. Orphan page without existing subject
    let r1 = sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title) VALUES ('p-orphan', 'nonexistent-sub', 'Title')")
        .execute(&pool)
        .await;
    assert!(
        r1.is_err(),
        "Inserting page with non-existent subject_id must fail FK check"
    );

    // 2. Orphan publication without existing page
    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-valid', 'Valid Subject')")
        .execute(&pool)
        .await
        .unwrap();

    let r2 = sqlx::query("INSERT INTO publications (page_id, subject_id, title, markdown, published_revision) VALUES ('p-ghost', 'sub-valid', 'Ghost', '', 1)")
        .execute(&pool)
        .await;
    assert!(
        r2.is_err(),
        "Inserting publication with non-existent page_id must fail FK check"
    );

    // 3. Orphan publication with valid page but nonexistent subject
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title) VALUES ('p-real', 'sub-valid', 'Real Page')")
        .execute(&pool)
        .await
        .unwrap();

    let r3 = sqlx::query("INSERT INTO publications (page_id, subject_id, title, markdown, published_revision) VALUES ('p-real', 'sub-ghost', 'Real Page', '', 1)")
        .execute(&pool)
        .await;
    assert!(
        r3.is_err(),
        "Inserting publication with non-existent subject_id must fail FK check"
    );

    // 4. Orphan asset without existing page
    let r4 = sqlx::query("INSERT INTO assets (id, page_id, stored_name, original_name, mime, byte_size, kind) VALUES ('ast-ghost', 'p-ghost', 'g', 'g.png', 'image/png', 10, 'image')")
        .execute(&pool)
        .await;
    assert!(
        r4.is_err(),
        "Inserting asset with non-existent page_id must fail FK check"
    );

    // 5. Orphan page_public_asset with nonexistent page or asset
    let r5 = sqlx::query(
        "INSERT INTO page_public_assets (page_id, asset_id) VALUES ('p-real', 'ast-ghost')",
    )
    .execute(&pool)
    .await;
    assert!(
        r5.is_err(),
        "Inserting page_public_asset with non-existent asset_id must fail FK check"
    );

    // 6. Orphan session without existing admin
    let r6 = sqlx::query("INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES ('tok-ghost', 99999, '2099-01-01')")
        .execute(&pool)
        .await;
    assert!(
        r6.is_err(),
        "Inserting session with non-existent admin_id must fail FK check"
    );
}

// ============================================================================
// 4. CHECK CONSTRAINT ON ASSET KIND
// ============================================================================

#[tokio::test]
async fn test_check_constraint_asset_kind_fuzz_matrix() {
    let pool = init_test_db().await.expect("Failed to initialize test db");

    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-chk', 'Testing')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title) VALUES ('p-chk', 'sub-chk', 'Testing Page')")
        .execute(&pool)
        .await
        .unwrap();

    // 1. Valid cases: 'image' and 'attachment'
    let ok1 = sqlx::query("INSERT INTO assets (id, page_id, stored_name, original_name, mime, byte_size, kind) VALUES ('ast-ok1', 'p-chk', 's1', 'f1.png', 'image/png', 100, 'image')")
        .execute(&pool)
        .await;
    assert!(ok1.is_ok(), "Valid kind 'image' must succeed");

    let ok2 = sqlx::query("INSERT INTO assets (id, page_id, stored_name, original_name, mime, byte_size, kind) VALUES ('ast-ok2', 'p-chk', 's2', 'f2.pdf', 'application/pdf', 100, 'attachment')")
        .execute(&pool)
        .await;
    assert!(ok2.is_ok(), "Valid kind 'attachment' must succeed");

    // 2. Adversarial invalid test vectors
    let invalid_kinds = vec![
        "IMAGE",
        "ATTACHMENT",
        "Image",
        "Attachment",
        "",
        " ",
        "  image  ",
        "attachment\0",
        "image\n",
        "executable",
        "script",
        "pdf",
        "svg",
        "video",
        "' OR '1'='1",
        "image; DROP TABLE assets;--",
    ];

    for (idx, bad_kind) in invalid_kinds.iter().enumerate() {
        let asset_id = format!("ast-bad-{idx}");
        let res = sqlx::query(
            "INSERT INTO assets (id, page_id, stored_name, original_name, mime, byte_size, kind) VALUES (?, 'p-chk', 's', 'f', 'application/octet-stream', 100, ?)"
        )
        .bind(&asset_id)
        .bind(bad_kind)
        .execute(&pool)
        .await;

        assert!(
            res.is_err(),
            "CHECK constraint failed to reject invalid kind '{bad_kind}'"
        );
        let err_msg = res.unwrap_err().to_string();
        assert!(
            err_msg.to_lowercase().contains("check constraint")
                || err_msg.to_lowercase().contains("constraint"),
            "Expected CHECK constraint error for '{bad_kind}', got: {err_msg}"
        );
    }
}

// ============================================================================
// 5. UNIQUE ADMIN USERNAME CONSTRAINT
// ============================================================================

#[tokio::test]
async fn test_unique_admin_username_enforcement() {
    let pool = init_test_db().await.expect("Failed to initialize test db");

    // 1. Initial admin insert succeeds
    let ins1 =
        sqlx::query("INSERT INTO admin (username, password_hash) VALUES ('author', 'hash_abc')")
            .execute(&pool)
            .await;
    assert!(ins1.is_ok(), "Initial admin creation must succeed");

    // 2. Duplicate username insert must fail
    let ins2 = sqlx::query(
        "INSERT INTO admin (username, password_hash) VALUES ('author', 'different_hash')",
    )
    .execute(&pool)
    .await;
    assert!(
        ins2.is_err(),
        "Duplicate admin username must be rejected by UNIQUE constraint"
    );
    let err_str = ins2.unwrap_err().to_string();
    assert!(
        err_str.to_lowercase().contains("unique") || err_str.to_lowercase().contains("constraint"),
        "Expected UNIQUE constraint error, got: {err_str}"
    );

    // 3. Different username succeeds
    let ins3 =
        sqlx::query("INSERT INTO admin (username, password_hash) VALUES ('editor', 'hash_xyz')")
            .execute(&pool)
            .await;
    assert!(ins3.is_ok(), "Distinct admin username must succeed");

    // 4. Update username to collide with existing admin must fail
    let upd_res = sqlx::query("UPDATE admin SET username = 'author' WHERE username = 'editor'")
        .execute(&pool)
        .await;
    assert!(
        upd_res.is_err(),
        "Updating username to existing username must violate UNIQUE constraint"
    );
}

// ============================================================================
// 6. SQLITE PRAGMAS & PRODUCTION DB CONFIGURATION (WAL, busy_timeout, foreign_keys)
// ============================================================================

#[tokio::test]
async fn test_production_sqlite_pragmas_on_file_database() {
    let temp_dir = tempdir().expect("Failed to create tempdir");
    let db_path = temp_dir.path().join("labnotes_pragma_test.db");
    let db_url = format!("sqlite://{}", db_path.to_str().unwrap().replace('\\', "/"));

    // Initialize using production init_db function
    let pool = init_db(&db_url).await.expect("init_db must succeed");

    // 1. Check WAL mode
    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode;")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        journal_mode.to_lowercase(),
        "wal",
        "SQLite production database must operate in WAL journal mode"
    );

    // 2. Check foreign_keys = 1 (ON)
    let fk_status: i64 = sqlx::query_scalar("PRAGMA foreign_keys;")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fk_status, 1, "PRAGMA foreign_keys must be enabled (1)");

    // 3. Check busy_timeout = 5000ms
    let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout;")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        busy_timeout, 5000,
        "PRAGMA busy_timeout must be set to 5000ms"
    );

    // 4. Check synchronous = 1 (NORMAL)
    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous;")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        synchronous, 1,
        "PRAGMA synchronous must be NORMAL (1) for WAL performance"
    );
}

#[tokio::test]
async fn test_foreign_keys_enforced_across_all_connections_in_pool() {
    let temp_dir = tempdir().expect("Failed to create tempdir");
    let db_path = temp_dir.path().join("labnotes_fk_pool_test.db");
    let db_url = format!("sqlite://{}", db_path.to_str().unwrap().replace('\\', "/"));

    let pool = init_db(&db_url).await.expect("init_db must succeed");

    // Pool has max_connections = 10. Check out each connection and verify foreign_keys = 1 and constraint enforcement
    let mut conns = Vec::new();
    for i in 0..10 {
        let mut conn = pool.acquire().await.expect("Acquire connection from pool");

        let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys;")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(fk, 1, "Connection #{i} must have foreign_keys = 1 enabled");

        // Attempt FK violation on this specific connection
        let bad_insert = sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title) VALUES ('bad', 'nonexistent', 'test')")
            .execute(&mut *conn)
            .await;
        assert!(
            bad_insert.is_err(),
            "Connection #{i} failed to enforce foreign key constraint"
        );

        conns.push(conn);
    }
}

// ============================================================================
// 7. CONCURRENCY STRESS TESTS (WAL Mode & Busy Timeout)
// ============================================================================

#[tokio::test]
async fn test_sqlite_wal_concurrency_stress_readers_and_writers() {
    let temp_dir = tempdir().expect("Failed to create tempdir");
    let db_path = temp_dir.path().join("labnotes_concurrency_stress.db");
    let db_url = format!("sqlite://{}", db_path.to_str().unwrap().replace('\\', "/"));

    let pool = Arc::new(init_db(&db_url).await.expect("init_db failed"));

    // Pre-populate with base subjects
    for s in 0..5 {
        sqlx::query("INSERT INTO subjects (id, name, position) VALUES (?, ?, ?)")
            .bind(format!("sub-{s}"))
            .bind(format!("Subject {s}"))
            .bind(s)
            .execute(&*pool)
            .await
            .unwrap();
    }

    let mut handles = Vec::new();

    // Spawn 10 concurrent writer tasks
    for worker_id in 0..10 {
        let pool = Arc::clone(&pool);
        let handle = tokio::spawn(async move {
            for iter in 0..10 {
                let page_id = format!("page-w{worker_id}-i{iter}");
                let sub_id = format!("sub-{}", iter % 5);

                // Insert page
                sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title, draft_markdown, revision) VALUES (?, ?, 'Title', 'Content', 1)")
                    .bind(&page_id)
                    .bind(&sub_id)
                    .execute(&*pool)
                    .await
                    .expect("Concurrent writer insert page");

                // Insert asset
                let asset_id = format!("ast-w{worker_id}-i{iter}");
                sqlx::query("INSERT INTO assets (id, page_id, stored_name, original_name, mime, byte_size, kind) VALUES (?, ?, 's', 'pic.png', 'image/png', 100, 'image')")
                    .bind(&asset_id)
                    .bind(&page_id)
                    .execute(&*pool)
                    .await
                    .expect("Concurrent writer insert asset");

                // Insert publication
                sqlx::query("INSERT INTO publications (page_id, subject_id, title, markdown, published_revision) VALUES (?, ?, 'Pub', 'Pub M', 1)")
                    .bind(&page_id)
                    .bind(&sub_id)
                    .execute(&*pool)
                    .await
                    .expect("Concurrent writer insert publication");

                // Sleep briefly to yield thread and induce interleaved scheduling
                sleep(Duration::from_millis(5)).await;
            }
        });
        handles.push(handle);
    }

    // Spawn 10 concurrent reader tasks
    for _reader_id in 0..10 {
        let pool = Arc::clone(&pool);
        let handle = tokio::spawn(async move {
            for _ in 0..20 {
                let page_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages")
                    .fetch_one(&*pool)
                    .await
                    .expect("Concurrent reader count pages");

                let pub_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM publications")
                    .fetch_one(&*pool)
                    .await
                    .expect("Concurrent reader count publications");

                let asset_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assets")
                    .fetch_one(&*pool)
                    .await
                    .expect("Concurrent reader count assets");

                // Sanity check: non-negative counts
                assert!(page_count >= 0);
                assert!(pub_count >= 0);
                assert!(asset_count >= 0);

                sleep(Duration::from_millis(3)).await;
            }
        });
        handles.push(handle);
    }

    // Await all 20 concurrent tasks
    for handle in handles {
        handle.await.expect("Worker task panicked or failed");
    }

    // Verify total inserted rows: 10 writers * 10 iterations = 100 pages, 100 assets, 100 publications
    let total_pages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages")
        .fetch_one(&*pool)
        .await
        .unwrap();
    assert_eq!(
        total_pages, 100,
        "All 100 pages must be successfully committed without concurrency locks"
    );

    let total_assets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assets")
        .fetch_one(&*pool)
        .await
        .unwrap();
    assert_eq!(
        total_assets, 100,
        "All 100 assets must be successfully committed"
    );

    let total_pubs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM publications")
        .fetch_one(&*pool)
        .await
        .unwrap();
    assert_eq!(
        total_pubs, 100,
        "All 100 publications must be successfully committed"
    );
}

#[tokio::test]
async fn test_concurrency_busy_timeout_queueing_behavior() {
    let temp_dir = tempdir().expect("Failed to create tempdir");
    let db_path = temp_dir.path().join("labnotes_busy_timeout_queue.db");
    let db_url = format!("sqlite://{}", db_path.to_str().unwrap().replace('\\', "/"));

    let pool = Arc::new(init_db(&db_url).await.expect("init_db failed"));

    sqlx::query("INSERT INTO subjects (id, name) VALUES ('sub-q', 'Queue Subject')")
        .execute(&*pool)
        .await
        .unwrap();

    let pool_holder = Arc::clone(&pool);
    // Task 1: Holds an IMMEDIATE transaction lock for 300ms
    let locker = tokio::spawn(async move {
        let mut tx = pool_holder.begin().await.expect("Begin immediate tx");
        sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title) VALUES ('p-locked', 'sub-q', 'Holding Lock')")
            .execute(&mut *tx)
            .await
            .expect("Insert in tx");

        // Hold lock for 300ms
        sleep(Duration::from_millis(300)).await;

        tx.commit().await.expect("Commit tx");
    });

    // Concurrently, 5 tasks try to write while Task 1 is holding the write lock
    let mut queue_handles = Vec::new();
    for q in 0..5 {
        let pool_q = Arc::clone(&pool);
        let h = tokio::spawn(async move {
            // Small initial sleep (50ms) to ensure Task 1 has already acquired the write lock
            sleep(Duration::from_millis(50)).await;

            let page_id = format!("p-queue-{q}");
            // Because busy_timeout is 5000ms, this write must wait for Task 1 to finish and succeed
            let res = sqlx::query("INSERT INTO pages (id, draft_subject_id, draft_title) VALUES (?, 'sub-q', 'Queued Page')")
                .bind(&page_id)
                .execute(&*pool_q)
                .await;

            assert!(
                res.is_ok(),
                "Queued write failed instead of waiting within busy_timeout: {:?}",
                res.err()
            );
        });
        queue_handles.push(h);
    }

    locker.await.expect("Lock holder task failed");
    for h in queue_handles {
        h.await.expect("Queued task failed");
    }

    // Verify all rows made it into the database: 1 locked + 5 queued = 6 pages
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE draft_subject_id = 'sub-q'")
            .fetch_one(&*pool)
            .await
            .unwrap();
    assert_eq!(
        count, 6,
        "All 6 pages must be present after busy_timeout queueing resolution"
    );
}
