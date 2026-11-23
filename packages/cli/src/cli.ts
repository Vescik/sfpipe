#!/usr/bin/env node
import { SfpipeError } from './core/errors.js';
import { defaultIo } from './io.js';
import { buildProgram } from './program.js';

const io = defaultIo();

try {
  await buildProgram(io).parseAsync(process.argv);
} catch (error) {
  if (error instanceof SfpipeError) {
    io.err(`✖ ${error.message}`);
    if (error.hint) io.err(`  → ${error.hint}`);
  } else {
    io.err(`✖ Nieoczekiwany błąd: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  io.setExitCode(1);
}
