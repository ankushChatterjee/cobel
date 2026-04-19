import BetterSqlite3, { type Database } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runMigrations } from './migrations'

export type { Database }

export function openDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new BetterSqlite3(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

export function openInMemoryDatabase(): Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}
