/**
 * Writes JSON.stringify(process.argv.slice(2)) to WIN_ARG_OUT when set.
 * Used on Windows runners to prove spawn argument preservation (no cmd injection).
 */
import { writeFileSync } from 'node:fs';

const out = process.env.WIN_ARG_OUT;
if (out) writeFileSync(out, JSON.stringify(process.argv.slice(2)), 'utf8');