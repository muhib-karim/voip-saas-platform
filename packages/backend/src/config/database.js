import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import config from './index.js';

export const migrationsDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../migrations'
);

const db = knex({
    client: 'pg',
    connection: config.databaseUrl,
    // DB_SCHEMA lets tests (or a shared database) run inside a private schema.
    searchPath: config.dbSchema ? [config.dbSchema, 'public'] : undefined,
    pool: {
        min: config.nodeEnv === 'test' ? 0 : 2,
        max: 10
    },
    migrations: {
        tableName: 'knex_migrations',
        directory: migrationsDirectory
    }
});

export default db;
