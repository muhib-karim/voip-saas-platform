import config from './src/config/index.js';
import { migrationsDirectory } from './src/config/database.js';

export default {
    client: 'pg',
    connection: config.databaseUrl,
    searchPath: config.dbSchema ? [config.dbSchema, 'public'] : undefined,
    migrations: {
        directory: migrationsDirectory,
        tableName: 'knex_migrations'
    },
    seeds: {
        directory: './seeds'
    }
};
