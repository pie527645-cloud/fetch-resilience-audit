import path from 'node:path';
import ts from 'typescript';
import type { Finding } from '../types.js';
import { buildModuleCallContext } from './astUtils.js';
import { analyzeBodyLeaks } from './bodyLeakAnalyzer.js';
import { analyzeUnboundedFanout } from './fanoutAnalyzer.js';
import { analyzeLoopSignals } from './loopSignalAnalyzer.js';

function getScriptKindForFile(fileName: string): ts.ScriptKind {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

export function auditSource(sourceText: string, fileLabel = 'input.ts'): Finding[] {
  const scriptKind = getScriptKindForFile(fileLabel);
  const sourceFile = ts.createSourceFile(
    fileLabel,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  const ctx = buildModuleCallContext(sourceFile);

  const findings: Finding[] = [
    ...analyzeBodyLeaks(ctx, fileLabel),
    ...analyzeLoopSignals(ctx, fileLabel),
    ...analyzeUnboundedFanout(ctx, fileLabel)
  ];

  findings.sort((a, b) => {
    if (a.file !== b.file) {
      return a.file.localeCompare(b.file);
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    if (a.column !== b.column) {
      return a.column - b.column;
    }
    return a.ruleId.localeCompare(b.ruleId);
  });

  return findings;
}
