import ts from 'typescript';
import type { Finding } from '../types.js';
import {
  classifyNetworkCall,
  createFinding,
  resolveLexicalDeclaration,
  unwrapExpression,
  type ModuleCallContext
} from './astUtils.js';

const ARRAY_MUTATION_METHODS: ReadonlySet<string> = new Set([
  'push',
  'unshift',
  'splice',
  'fill',
  'copyWithin'
]);

const QUEUE_SCHEDULE_METHODS: ReadonlySet<string> = new Set([
  'add',
  'addAll',
  'enqueue',
  'run',
  'schedule',
  'runExclusive',
  'acquire',
  'wrap'
]);

function isPromiseCombinator(call: ts.CallExpression): 'all' | 'allSettled' | null {
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) {
    return null;
  }
  const method = callee.name.text;
  if (method !== 'all' && method !== 'allSettled') {
    return null;
  }
  const obj = unwrapExpression(callee.expression);
  if (ts.isIdentifier(obj) && obj.text === 'Promise') {
    return method;
  }
  if (ts.isPropertyAccessExpression(obj) && obj.name.text === 'Promise') {
    const root = unwrapExpression(obj.expression);
    if (
      ts.isIdentifier(root) &&
      (root.text === 'globalThis' || root.text === 'window' || root.text === 'self')
    ) {
      return method;
    }
  }
  return null;
}

function extractMapCall(
  argExpr: ts.Expression
): { arrExpr: ts.Expression; mapArg: ts.Expression } | null {
  const u = unwrapExpression(argExpr);
  if (ts.isCallExpression(u) && u.arguments.length >= 1) {
    const callee = unwrapExpression(u.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'map') {
      const firstArg = u.arguments[0];
      if (firstArg) {
        return { arrExpr: callee.expression, mapArg: firstArg };
      }
    }
  }

  if (ts.isIdentifier(u)) {
    const decl = resolveLexicalDeclaration(u, u.text);
    if (
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.parent &&
      ts.isVariableDeclarationList(decl.parent) &&
      (decl.parent.flags & ts.NodeFlags.Const) !== 0 &&
      decl.initializer
    ) {
      return extractMapCall(decl.initializer);
    }
  }

  return null;
}

function isLimiterIdentifierName(name: string): boolean {
  const lower = name.toLowerCase();
  if (
    lower === 'limit' ||
    lower === 'limiter' ||
    lower === 'plimit' ||
    lower === 'pmap' ||
    lower === 'pqueue' ||
    lower === 'throat' ||
    lower === 'bottleneck' ||
    lower === 'semaphore' ||
    lower === 'sema'
  ) {
    return true;
  }
  if (
    lower.endsWith('limit') ||
    lower.endsWith('limiter') ||
    lower.startsWith('limit') ||
    lower.includes('semaphore') ||
    lower.includes('plimit') ||
    lower.includes('pmap') ||
    lower.includes('pqueue') ||
    lower.includes('bottleneck') ||
    lower.includes('throat')
  ) {
    return true;
  }
  return false;
}

function usesConcurrencyLimiter(mapArg: ts.Expression, ctx: ModuleCallContext): boolean {
  let foundLimiter = false;

  function scan(node: ts.Node): void {
    if (foundLimiter) {
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee)) {
        if (ctx.limiterIdentifiers.has(callee.text) || isLimiterIdentifierName(callee.text)) {
          foundLimiter = true;
          return;
        }
      } else if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const receiver = unwrapExpression(callee.expression);
        if (method === 'acquire' || method === 'runExclusive' || method === 'schedule') {
          foundLimiter = true;
          return;
        }
        if (ts.isIdentifier(receiver)) {
          const lowerReceiver = receiver.text.toLowerCase();
          if (
            ctx.limiterIdentifiers.has(receiver.text) ||
            isLimiterIdentifierName(receiver.text) ||
            (QUEUE_SCHEDULE_METHODS.has(method) && lowerReceiver.includes('queue'))
          ) {
            foundLimiter = true;
            return;
          }
        } else if (
          ts.isPropertyAccessExpression(receiver) &&
          receiver.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          const fieldLower = receiver.name.text.toLowerCase();
          if (
            isLimiterIdentifierName(receiver.name.text) ||
            (QUEUE_SCHEDULE_METHODS.has(method) && fieldLower.includes('queue'))
          ) {
            foundLimiter = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, scan);
  }

  scan(mapArg);
  return foundLimiter;
}

function callbackHasNetworkCall(mapArg: ts.Expression, ctx: ModuleCallContext): boolean {
  const u = unwrapExpression(mapArg);
  if (ts.isIdentifier(u)) {
    if (
      (u.text === 'fetch' && !ctx.nonHttpFetchIdentifiers.has('fetch') && resolveLexicalDeclaration(u, 'fetch') === null) ||
      ctx.undiciFetchIdentifiers.has(u.text) ||
      ctx.undiciRequestIdentifiers.has(u.text)
    ) {
      return true;
    }
  }

  let hasNetCall = false;
  function scan(node: ts.Node): void {
    if (hasNetCall) {
      return;
    }
    if (ts.isCallExpression(node) && classifyNetworkCall(node, ctx) !== null) {
      hasNetCall = true;
      return;
    }
    ts.forEachChild(node, scan);
  }

  scan(u);
  return hasNetCall;
}

function isArrayVariableMutated(
  declNode: ts.VariableDeclaration,
  varName: string,
  sourceFile: ts.SourceFile
): boolean {
  let scopeRoot: ts.Node = sourceFile;
  let cur: ts.Node | undefined = declNode.parent;
  while (cur) {
    if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur)) {
      scopeRoot = cur;
      break;
    }
    cur = cur.parent;
  }

  let mutated = false;
  function scan(node: ts.Node): void {
    if (mutated) {
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isPropertyAccessExpression(callee) && ARRAY_MUTATION_METHODS.has(callee.name.text)) {
        const obj = unwrapExpression(callee.expression);
        if (ts.isIdentifier(obj) && obj.text === varName) {
          if (resolveLexicalDeclaration(obj, varName) === declNode) {
            mutated = true;
            return;
          }
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const lhs = unwrapExpression(node.left);
      if (ts.isElementAccessExpression(lhs)) {
        const obj = unwrapExpression(lhs.expression);
        if (ts.isIdentifier(obj) && obj.text === varName) {
          if (resolveLexicalDeclaration(obj, varName) === declNode) {
            mutated = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, scan);
  }

  scan(scopeRoot);
  return mutated;
}

function isSmallUnspreadArrayLiteral(lit: ts.ArrayLiteralExpression): boolean {
  if (lit.elements.length > 10) {
    return false;
  }
  for (const el of lit.elements) {
    if (ts.isSpreadElement(el)) {
      return false;
    }
  }
  return true;
}

function isBoundedArraySource(arrExpr: ts.Expression, sourceFile: ts.SourceFile): boolean {
  const u = unwrapExpression(arrExpr);

  if (ts.isArrayLiteralExpression(u)) {
    return isSmallUnspreadArrayLiteral(u);
  }

  if (ts.isIdentifier(u)) {
    const decl = resolveLexicalDeclaration(u, u.text);
    if (
      decl &&
      ts.isVariableDeclaration(decl) &&
      decl.parent &&
      ts.isVariableDeclarationList(decl.parent) &&
      (decl.parent.flags & ts.NodeFlags.Const) !== 0 &&
      decl.initializer
    ) {
      if (isArrayVariableMutated(decl, u.text, sourceFile)) {
        return false;
      }
      const init = unwrapExpression(decl.initializer);
      if (ts.isArrayLiteralExpression(init)) {
        return isSmallUnspreadArrayLiteral(init);
      }
      if (hasSliceBatchingInChain(init)) {
        return true;
      }
    }
  }

  return hasSliceBatchingInChain(u);
}

function hasSliceBatchingInChain(expr: ts.Expression): boolean {
  const u = unwrapExpression(expr);
  if (!ts.isCallExpression(u)) {
    return false;
  }
  const callee = unwrapExpression(u.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === 'slice' && u.arguments.length >= 1) {
      return true;
    }
    return hasSliceBatchingInChain(callee.expression);
  }
  return false;
}

export function analyzeUnboundedFanout(
  ctx: ModuleCallContext,
  fileLabel: string
): Finding[] {
  const findings: Finding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const combinator = isPromiseCombinator(node);
      const firstArg = node.arguments[0];
      if (combinator !== null && firstArg) {
        const mapParts = extractMapCall(firstArg);
        if (mapParts !== null) {
          if (
            callbackHasNetworkCall(mapParts.mapArg, ctx) &&
            !usesConcurrencyLimiter(mapParts.mapArg, ctx) &&
            !isBoundedArraySource(mapParts.arrExpr, ctx.sourceFile)
          ) {
            findings.push(
              createFinding(
                ctx.sourceFile,
                fileLabel,
                'FRA004',
                node,
                `Promise.${combinator}(<arr>.map(...)) dispatches concurrent network requests without a concurrency limiter (e.g. p-limit) or .slice() batching.`
              )
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(ctx.sourceFile);
  return findings;
}
