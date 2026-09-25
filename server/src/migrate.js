import { migrate, closeDb } from './db.js';

await migrate();
console.log('Migrations applied.');
await closeDb();
