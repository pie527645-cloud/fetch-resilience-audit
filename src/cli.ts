#!/usr/bin/env node
import { runCli } from './cliRunner.js';

process.exitCode = runCli(process.argv.slice(2));
