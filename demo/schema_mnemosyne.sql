CREATE TABLE working_memory (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            source TEXT,
            timestamp TEXT,
            session_id TEXT DEFAULT 'default',
            importance REAL DEFAULT 0.5,
            metadata_json TEXT,
            veracity TEXT DEFAULT 'unknown',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        , memory_type TEXT DEFAULT 'unknown', consolidated_at TEXT, consolidation_claimed_at TEXT, recall_count INTEGER DEFAULT 0, last_recalled TIMESTAMP DEFAULT NULL, pinned INTEGER DEFAULT 0, valid_until TIMESTAMP DEFAULT NULL, superseded_by TEXT DEFAULT NULL, scope TEXT DEFAULT 'global', author_id TEXT DEFAULT NULL, author_type TEXT DEFAULT NULL, channel_id TEXT DEFAULT NULL, trust_tier TEXT DEFAULT 'STATED', validator TEXT DEFAULT NULL, validated_at TIMESTAMP DEFAULT NULL, validation_count INTEGER DEFAULT 0, event_date TEXT DEFAULT NULL, event_date_precision TEXT DEFAULT 'unknown', temporal_tags TEXT DEFAULT '[]', corrected_by INTEGER DEFAULT NULL);
CREATE TABLE episodic_memory (
            rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT UNIQUE NOT NULL,
            content TEXT NOT NULL,
            source TEXT,
            timestamp TEXT,
            session_id TEXT DEFAULT 'default',
            importance REAL DEFAULT 0.5,
            metadata_json TEXT,
            summary_of TEXT DEFAULT '',
            veracity TEXT DEFAULT 'unknown',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        , tier INTEGER DEFAULT 1, degraded_at TEXT, memory_type TEXT DEFAULT 'unknown', binary_vector BLOB, recall_count INTEGER DEFAULT 0, last_recalled TIMESTAMP DEFAULT NULL, valid_until TIMESTAMP DEFAULT NULL, superseded_by TEXT DEFAULT NULL, scope TEXT DEFAULT 'global', author_id TEXT DEFAULT NULL, author_type TEXT DEFAULT NULL, channel_id TEXT DEFAULT NULL, trust_tier TEXT DEFAULT 'STATED', validator TEXT DEFAULT NULL, validated_at TIMESTAMP DEFAULT NULL, validation_count INTEGER DEFAULT 0, event_date TEXT DEFAULT NULL, event_date_precision TEXT DEFAULT 'unknown', temporal_tags TEXT DEFAULT '[]', corrected_by INTEGER DEFAULT NULL);
CREATE TABLE facts (
            fact_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            subject TEXT NOT NULL,
            predicate TEXT NOT NULL,
            object TEXT NOT NULL,
            timestamp TEXT,
            source_msg_id TEXT,
            confidence REAL DEFAULT 1.0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE canonical_facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id TEXT NOT NULL,
            category TEXT NOT NULL,
            name TEXT NOT NULL,
            body TEXT NOT NULL,
            source TEXT,
            confidence REAL DEFAULT 1.0,
            version INTEGER NOT NULL DEFAULT 1,
            valid_from TEXT NOT NULL,
            valid_until TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        , writer_id TEXT, writer_home TEXT);
CREATE TABLE triples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject TEXT NOT NULL,
            predicate TEXT NOT NULL,
            object TEXT NOT NULL,
            valid_from TEXT NOT NULL,
            valid_until TEXT,
            source TEXT,
            confidence REAL DEFAULT 1.0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE graph_edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                target TEXT NOT NULL,
                edge_type TEXT NOT NULL,
                weight REAL DEFAULT 1.0,
                timestamp TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
