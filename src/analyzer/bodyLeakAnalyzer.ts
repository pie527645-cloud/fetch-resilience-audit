import ts from 'typescript';
import type { Finding } from '../types.js';
import {
  classifyNetworkCall,
  createFinding,
  isHeadMethodCall,
  unwrapExpression,
  type ModuleCallContext,
  type NetworkCallKind
} from './astUtils.js';

const RESPONSE_CONSUME_METHODS: ReadonlySet<string> = new Set([
  'text',
  'json',
  'arrayBuffer',
  'blob',
  'formData',
  'bytes',
  'dump',
  'cancel',
  'destroy',
  'resume'
]);

const BODY_CONSUME_METHODS: ReadonlySet<string> = new Set([
  'dump',
  'text',
  'json',
  'arrayBuffer',
  'blob',
  'formData',
  'bytes',
  'cancel',
  'destroy',
  'resume',
  'pipe',
  'pipeTo',
  'pipeThrough',
  'getReader'
]);

const CONSOLE_METHODS: ReadonlySet<string> = new Set([
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'dir'
]);

interface ResponseAllocation {
  kind: NetworkCallKind;
  anchorNode: ts.Node;
  creationNode: ts.Node;
  responseNames: Set<string>;
  bodyNames: Set<string>;
}

interface PathState {
  reachable: boolean;
  created: boolean;
  mayBeUnconsumed: boolean;
}

interface LeakSite {
  node: ts.Node;
  reason: string;
}

interface SimEnv {
  finallyProtected: boolean;
  activeCatchThrows: PathState[] | null;
  enclosingLoopCreatedDepth: number;
  currentLoopDepth: number;
}

function isConsoleCall(call: ts.CallExpression): boolean {
  const callee = unwrapExpression(call.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    const obj = unwrapExpression(callee.expression);
    if (ts.isIdentifier(obj) && obj.text === 'console' && CONSOLE_METHODS.has(callee.name.text)) {
      return true;
    }
  }
  return false;
}

function isResponseIdent(expr: ts.Expression, alloc: ResponseAllocation): boolean {
  const u = unwrapExpression(expr);
  return ts.isIdentifier(u) && alloc.responseNames.has(u.text);
}

function isBodyExpr(expr: ts.Expression, alloc: ResponseAllocation): boolean {
  const u = unwrapExpression(expr);
  if (ts.isIdentifier(u) && alloc.bodyNames.has(u.text)) {
    return true;
  }
  if (ts.isPropertyAccessExpression(u) && u.name.text === 'body') {
    return isResponseIdent(u.expression, alloc);
  }
  return false;
}

function isBodyPresenceCheck(expr: ts.Expression, alloc: ResponseAllocation): 'truthy' | 'falsy' | null {
  const u = unwrapExpression(expr);
  if (isBodyExpr(u, alloc)) {
    return 'truthy';
  }
  if (ts.isPrefixUnaryExpression(u) && u.operator === ts.SyntaxKind.ExclamationToken) {
    if (isBodyExpr(u.operand, alloc)) {
      return 'falsy';
    }
  }
  if (ts.isBinaryExpression(u)) {
    const op = u.operatorToken.kind;
    const left = unwrapExpression(u.left);
    const right = unwrapExpression(u.right);
    const rightIsNullish =
      right.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(right) && right.text === 'undefined');
    const leftIsNullish =
      left.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(left) && left.text === 'undefined');

    if ((isBodyExpr(left, alloc) && rightIsNullish) || (isBodyExpr(right, alloc) && leftIsNullish)) {
      if (op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        return 'truthy';
      }
      if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        return 'falsy';
      }
    }
  }
  return null;
}

function expressionConsumes(expr: ts.Expression, alloc: ResponseAllocation): boolean {
  const u = unwrapExpression(expr);

  if (ts.isFunctionLike(u)) {
    return false;
  }

  if (ts.isAwaitExpression(u)) {
    return expressionConsumes(u.expression, alloc);
  }

  if (ts.isConditionalExpression(u)) {
    if (expressionConsumes(u.condition, alloc)) {
      return true;
    }
    return expressionConsumes(u.whenTrue, alloc) && expressionConsumes(u.whenFalse, alloc);
  }

  if (ts.isBinaryExpression(u)) {
    const op = u.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      if (expressionConsumes(u.left, alloc)) {
        return true;
      }
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken &&
        isBodyPresenceCheck(u.left, alloc) === 'truthy' &&
        expressionConsumes(u.right, alloc)
      ) {
        return true;
      }
      return false;
    }
    return expressionConsumes(u.left, alloc) || expressionConsumes(u.right, alloc);
  }

  if (ts.isCallExpression(u)) {
    const callee = unwrapExpression(u.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const methodName = callee.name.text;
      if (isResponseIdent(callee.expression, alloc) && RESPONSE_CONSUME_METHODS.has(methodName)) {
        return true;
      }
      if (isBodyExpr(callee.expression, alloc) && BODY_CONSUME_METHODS.has(methodName)) {
        return true;
      }
    }

    if (!isConsoleCall(u)) {
      for (const arg of u.arguments) {
        const uArg = unwrapExpression(arg);
        if (isResponseIdent(uArg, alloc) || isBodyExpr(uArg, alloc)) {
          return true;
        }
      }
    }

    if (expressionConsumes(u.expression, alloc)) {
      return true;
    }
    for (const arg of u.arguments) {
      if (expressionConsumes(arg, alloc)) {
        return true;
      }
    }
    return false;
  }

  if (ts.isNewExpression(u)) {
    if (u.arguments) {
      for (const arg of u.arguments) {
        const uArg = unwrapExpression(arg);
        if (isResponseIdent(uArg, alloc) || isBodyExpr(uArg, alloc)) {
          return true;
        }
        if (expressionConsumes(arg, alloc)) {
          return true;
        }
      }
    }
    return false;
  }

  let consumedInChild = false;
  ts.forEachChild(u, (child) => {
    if (consumedInChild || ts.isFunctionLike(child)) {
      return;
    }
    if (ts.isExpression(child) && expressionConsumes(child, alloc)) {
      consumedInChild = true;
    }
  });
  return consumedInChild;
}

function expressionReturnsOwnership(expr: ts.Expression, alloc: ResponseAllocation): boolean {
  const u = unwrapExpression(expr);
  if (ts.isAwaitExpression(u)) {
    return expressionReturnsOwnership(u.expression, alloc);
  }
  if (isResponseIdent(u, alloc) || isBodyExpr(u, alloc)) {
    return true;
  }
  if (ts.isConditionalExpression(u)) {
    const trueClean =
      expressionReturnsOwnership(u.whenTrue, alloc) || expressionConsumes(u.whenTrue, alloc);
    const falseClean =
      expressionReturnsOwnership(u.whenFalse, alloc) || expressionConsumes(u.whenFalse, alloc);
    return trueClean && falseClean;
  }
  return false;
}

function isChainedDirectConsumeOrReturn(awaitNode: ts.AwaitExpression): boolean {
  let current: ts.Node = awaitNode;
  while (current.parent && ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  if (!parent) {
    return false;
  }

  if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) {
    return true;
  }

  if (ts.isCallExpression(parent) && !isConsoleCall(parent)) {
    for (const arg of parent.arguments) {
      if (unwrapExpression(arg) === awaitNode) {
        return true;
      }
    }
  }

  if (ts.isPropertyAccessExpression(parent)) {
    const propName = parent.name.text;
    if (RESPONSE_CONSUME_METHODS.has(propName) && parent.parent && ts.isCallExpression(parent.parent)) {
      return true;
    }
    if (propName === 'body' && parent.parent && ts.isPropertyAccessExpression(parent.parent)) {
      const bodyMethod = parent.parent.name.text;
      if (
        BODY_CONSUME_METHODS.has(bodyMethod) &&
        parent.parent.parent &&
        ts.isCallExpression(parent.parent.parent)
      ) {
        return true;
      }
    }
  }

  return false;
}

function mergeStates(a: PathState, b: PathState): PathState {
  if (!a.reachable && !b.reachable) {
    return { reachable: false, created: a.created || b.created, mayBeUnconsumed: false };
  }
  if (!a.reachable) {
    return { ...b };
  }
  if (!b.reachable) {
    return { ...a };
  }
  return {
    reachable: true,
    created: a.created || b.created,
    mayBeUnconsumed: a.mayBeUnconsumed || b.mayBeUnconsumed
  };
}

function mergeManyStates(states: readonly PathState[]): PathState {
  let acc: PathState = { reachable: false, created: false, mayBeUnconsumed: false };
  for (const s of states) {
    acc = mergeStates(acc, s);
  }
  return acc;
}

function registerAliasesInDeclaration(decl: ts.VariableDeclaration, alloc: ResponseAllocation): void {
  if (!decl.initializer) {
    return;
  }
  const init = unwrapExpression(decl.initializer);
  if (isResponseIdent(init, alloc)) {
    if (ts.isIdentifier(decl.name)) {
      alloc.responseNames.add(decl.name.text);
    } else if (ts.isObjectBindingPattern(decl.name)) {
      for (const el of decl.name.elements) {
        const propName =
          el.propertyName && ts.isIdentifier(el.propertyName)
            ? el.propertyName.text
            : ts.isIdentifier(el.name)
              ? el.name.text
              : null;
        if (propName === 'body' && ts.isIdentifier(el.name)) {
          alloc.bodyNames.add(el.name.text);
        }
      }
    }
  } else if (isBodyExpr(init, alloc) && ts.isIdentifier(decl.name)) {
    alloc.bodyNames.add(decl.name.text);
  }
}

function simulateAllocationInScope(
  statements: readonly ts.Statement[],
  alloc: ResponseAllocation,
  sourceFile: ts.SourceFile
): LeakSite | null {
  let firstLeak: LeakSite | null = null;

  function recordLeak(node: ts.Node, reason: string): void {
    if (!firstLeak) {
      firstLeak = { node, reason };
    }
  }

  function lineOf(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function doesFinallyConsume(finallyBlock: ts.Block): boolean {
    const savedLeak = firstLeak;
    const dummyEnv: SimEnv = {
      finallyProtected: true,
      activeCatchThrows: null,
      enclosingLoopCreatedDepth: -1,
      currentLoopDepth: 0
    };
    const out = simBlock(
      finallyBlock.statements,
      { reachable: true, created: true, mayBeUnconsumed: true },
      dummyEnv
    );
    firstLeak = savedLeak;
    return !out.mayBeUnconsumed;
  }

  function evalExprInFlow(expr: ts.Expression, state: PathState, env: SimEnv): PathState {
    if (!state.reachable) {
      return state;
    }

    let next = { ...state };

    function scanCreation(node: ts.Node): void {
      if (ts.isFunctionLike(node)) {
        return;
      }
      if (node === alloc.creationNode) {
        if (next.created && next.mayBeUnconsumed && !env.finallyProtected) {
          recordLeak(node, `previous response body overwritten without being consumed at line ${lineOf(node)}`);
        }
        next = { reachable: true, created: true, mayBeUnconsumed: true };
        if (env.currentLoopDepth > 0 && env.enclosingLoopCreatedDepth === -1) {
          env.enclosingLoopCreatedDepth = env.currentLoopDepth;
        }
        return;
      }
      ts.forEachChild(node, scanCreation);
    }

    scanCreation(expr);

    if (next.created && next.mayBeUnconsumed && expressionConsumes(expr, alloc)) {
      next = { ...next, mayBeUnconsumed: false };
    }

    return next;
  }

  function simStatement(stmt: ts.Statement, state: PathState, env: SimEnv): PathState {
    if (!state.reachable) {
      return state;
    }

    if (ts.isBlock(stmt)) {
      return simBlock(stmt.statements, state, env);
    }

    if (ts.isVariableStatement(stmt)) {
      let cur = { ...state };
      for (const decl of stmt.declarationList.declarations) {
        if (decl === alloc.creationNode) {
          if (decl.initializer) {
            cur = evalExprInFlow(decl.initializer, cur, env);
          }
          cur = { reachable: true, created: true, mayBeUnconsumed: true };
          if (env.currentLoopDepth > 0 && env.enclosingLoopCreatedDepth === -1) {
            env.enclosingLoopCreatedDepth = env.currentLoopDepth;
          }
        } else {
          if (decl.initializer) {
            cur = evalExprInFlow(decl.initializer, cur, env);
          }
          if (cur.created) {
            registerAliasesInDeclaration(decl, alloc);
          }
        }
      }
      return cur;
    }

    if (ts.isExpressionStatement(stmt)) {
      return evalExprInFlow(stmt.expression, state, env);
    }

    if (ts.isReturnStatement(stmt)) {
      let cur = { ...state };
      if (stmt.expression) {
        cur = evalExprInFlow(stmt.expression, cur, env);
        if (cur.created && cur.mayBeUnconsumed && expressionReturnsOwnership(stmt.expression, alloc)) {
          cur = { ...cur, mayBeUnconsumed: false };
        }
      }
      if (cur.created && cur.mayBeUnconsumed && !env.finallyProtected) {
        recordLeak(
          stmt,
          `response body is neither consumed nor cancelled before return at line ${lineOf(stmt)}`
        );
      }
      return { reachable: false, created: cur.created, mayBeUnconsumed: false };
    }

    if (ts.isThrowStatement(stmt)) {
      let cur = evalExprInFlow(stmt.expression, state, env);
      if (env.activeCatchThrows !== null) {
        env.activeCatchThrows.push({ ...cur });
      } else if (cur.created && cur.mayBeUnconsumed && !env.finallyProtected) {
        recordLeak(
          stmt,
          `response body is neither consumed nor cancelled before throw at line ${lineOf(stmt)}`
        );
      }
      return { reachable: false, created: cur.created, mayBeUnconsumed: false };
    }

    if (ts.isIfStatement(stmt)) {
      const afterCond = evalExprInFlow(stmt.expression, state, env);
      const bodyGuard = afterCond.created ? isBodyPresenceCheck(stmt.expression, alloc) : null;

      const thenBase: PathState =
        bodyGuard === 'falsy' ? { ...afterCond, mayBeUnconsumed: false } : { ...afterCond };
      const elseBase: PathState =
        bodyGuard === 'truthy' ? { ...afterCond, mayBeUnconsumed: false } : { ...afterCond };

      const thenOut = simStatement(stmt.thenStatement, thenBase, env);
      const elseOut = stmt.elseStatement ? simStatement(stmt.elseStatement, elseBase, env) : elseBase;
      return mergeStates(thenOut, elseOut);
    }

    if (ts.isTryStatement(stmt)) {
      const hasFinallyConsume = stmt.finallyBlock ? doesFinallyConsume(stmt.finallyBlock) : false;
      const tryProtected = env.finallyProtected || hasFinallyConsume;

      if (stmt.catchClause) {
        const caughtThrows: PathState[] = [];
        const tryEnv: SimEnv = {
          ...env,
          finallyProtected: tryProtected,
          activeCatchThrows: caughtThrows
        };
        const afterTry = simBlock(stmt.tryBlock.statements, state, tryEnv);

        const catchEntry =
          caughtThrows.length > 0
            ? mergeManyStates(caughtThrows)
            : { reachable: true, created: false, mayBeUnconsumed: false };
        const catchEnv: SimEnv = {
          ...env,
          finallyProtected: tryProtected
        };
        const afterCatch = simBlock(stmt.catchClause.block.statements, catchEntry, catchEnv);
        let merged = mergeStates(afterTry, afterCatch);

        if (stmt.finallyBlock) {
          merged = simBlock(stmt.finallyBlock.statements, merged, env);
          if (hasFinallyConsume && merged.reachable) {
            merged = { ...merged, mayBeUnconsumed: false };
          }
        }
        return merged;
      }

      const tryEnv: SimEnv = {
        ...env,
        finallyProtected: tryProtected
      };
      let afterTry = simBlock(stmt.tryBlock.statements, state, tryEnv);
      if (stmt.finallyBlock) {
        afterTry = simBlock(stmt.finallyBlock.statements, afterTry, env);
        if (hasFinallyConsume && afterTry.reachable) {
          afterTry = { ...afterTry, mayBeUnconsumed: false };
        }
      }
      return afterTry;
    }

    if (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt)) {
      let cur = evalExprInFlow(stmt.expression, state, env);
      if (
        ts.isForOfStatement(stmt) &&
        cur.created &&
        cur.mayBeUnconsumed &&
        (isBodyExpr(stmt.expression, alloc) || isResponseIdent(stmt.expression, alloc))
      ) {
        cur = { ...cur, mayBeUnconsumed: false };
      }

      const nextLoopDepth = env.currentLoopDepth + 1;
      const loopEnv: SimEnv = {
        ...env,
        currentLoopDepth: nextLoopDepth
      };
      const bodyOut = simStatement(stmt.statement, { ...cur }, loopEnv);
      if (
        loopEnv.enclosingLoopCreatedDepth === nextLoopDepth &&
        bodyOut.reachable &&
        bodyOut.created &&
        bodyOut.mayBeUnconsumed &&
        !env.finallyProtected
      ) {
        recordLeak(stmt, `response body created inside loop is not consumed before iteration ends`);
      }
      return mergeStates(cur, bodyOut);
    }

    if (ts.isForStatement(stmt)) {
      let cur = { ...state };
      if (stmt.initializer) {
        if (ts.isVariableDeclarationList(stmt.initializer)) {
          for (const d of stmt.initializer.declarations) {
            if (d.initializer) {
              cur = evalExprInFlow(d.initializer, cur, env);
            }
          }
        } else {
          cur = evalExprInFlow(stmt.initializer, cur, env);
        }
      }
      if (stmt.condition) {
        cur = evalExprInFlow(stmt.condition, cur, env);
      }
      const nextLoopDepth = env.currentLoopDepth + 1;
      const loopEnv: SimEnv = { ...env, currentLoopDepth: nextLoopDepth };
      let bodyOut = simStatement(stmt.statement, { ...cur }, loopEnv);
      if (stmt.incrementor) {
        bodyOut = evalExprInFlow(stmt.incrementor, bodyOut, loopEnv);
      }
      if (
        loopEnv.enclosingLoopCreatedDepth === nextLoopDepth &&
        bodyOut.reachable &&
        bodyOut.created &&
        bodyOut.mayBeUnconsumed &&
        !env.finallyProtected
      ) {
        recordLeak(stmt, `response body created inside loop is not consumed before iteration ends`);
      }
      return mergeStates(cur, bodyOut);
    }

    if (ts.isWhileStatement(stmt)) {
      const cur = evalExprInFlow(stmt.expression, state, env);
      const nextLoopDepth = env.currentLoopDepth + 1;
      const loopEnv: SimEnv = { ...env, currentLoopDepth: nextLoopDepth };
      const bodyOut = simStatement(stmt.statement, { ...cur }, loopEnv);
      if (
        loopEnv.enclosingLoopCreatedDepth === nextLoopDepth &&
        bodyOut.reachable &&
        bodyOut.created &&
        bodyOut.mayBeUnconsumed &&
        !env.finallyProtected
      ) {
        recordLeak(stmt, `response body created inside loop is not consumed before iteration ends`);
      }
      return mergeStates(cur, bodyOut);
    }

    if (ts.isDoStatement(stmt)) {
      const nextLoopDepth = env.currentLoopDepth + 1;
      const loopEnv: SimEnv = { ...env, currentLoopDepth: nextLoopDepth };
      let bodyOut = simStatement(stmt.statement, { ...state }, loopEnv);
      bodyOut = evalExprInFlow(stmt.expression, bodyOut, loopEnv);
      if (
        loopEnv.enclosingLoopCreatedDepth === nextLoopDepth &&
        bodyOut.reachable &&
        bodyOut.created &&
        bodyOut.mayBeUnconsumed &&
        !env.finallyProtected
      ) {
        recordLeak(stmt, `response body created inside loop is not consumed before iteration ends`);
      }
      return bodyOut;
    }

    if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
      if (
        env.enclosingLoopCreatedDepth > 0 &&
        state.created &&
        state.mayBeUnconsumed &&
        !env.finallyProtected
      ) {
        const kw = ts.isBreakStatement(stmt) ? 'break' : 'continue';
        recordLeak(
          stmt,
          `response body is neither consumed nor cancelled before ${kw} at line ${lineOf(stmt)}`
        );
      }
      return { reachable: false, created: state.created, mayBeUnconsumed: false };
    }

    if (ts.isSwitchStatement(stmt)) {
      const afterExpr = evalExprInFlow(stmt.expression, state, env);
      let hasDefault = false;
      const exitStates: PathState[] = [];
      let fallthrough: PathState = { reachable: false, created: false, mayBeUnconsumed: false };

      for (const clause of stmt.caseBlock.clauses) {
        if (ts.isDefaultClause(clause)) {
          hasDefault = true;
        }
        let clauseState = mergeStates(afterExpr, fallthrough);
        if (ts.isCaseClause(clause)) {
          clauseState = evalExprInFlow(clause.expression, clauseState, env);
        }
        for (const cStmt of clause.statements) {
          if (!clauseState.reachable) {
            break;
          }
          if (ts.isBreakStatement(cStmt)) {
            exitStates.push({ ...clauseState });
            clauseState = { reachable: false, created: clauseState.created, mayBeUnconsumed: false };
            break;
          }
          clauseState = simStatement(cStmt, clauseState, env);
        }
        fallthrough = clauseState;
      }
      exitStates.push(fallthrough);
      if (!hasDefault) {
        exitStates.push(afterExpr);
      }
      return mergeManyStates(exitStates);
    }

    return state;
  }

  function simBlock(stmts: readonly ts.Statement[], initial: PathState, env: SimEnv): PathState {
    let cur = { ...initial };
    for (const s of stmts) {
      if (!cur.reachable) {
        break;
      }
      cur = simStatement(s, cur, env);
    }
    return cur;
  }

  const rootEnv: SimEnv = {
    finallyProtected: false,
    activeCatchThrows: null,
    enclosingLoopCreatedDepth: -1,
    currentLoopDepth: 0
  };

  const finalState = simBlock(
    statements,
    { reachable: true, created: false, mayBeUnconsumed: false },
    rootEnv
  );

  if (finalState.reachable && finalState.created && finalState.mayBeUnconsumed) {
    recordLeak(
      alloc.anchorNode,
      'response body is never consumed or cancelled before scope exit'
    );
  }

  return firstLeak;
}

function analyzeStatementScope(
  statements: readonly ts.Statement[],
  ctx: ModuleCallContext,
  fileLabel: string,
  findings: Finding[]
): void {
  const allocations: ResponseAllocation[] = [];

  function collectInScope(node: ts.Node): void {
    if (ts.isFunctionLike(node)) {
      return;
    }

    if (ts.isAwaitExpression(node)) {
      const inner = unwrapExpression(node.expression);
      if (ts.isCallExpression(inner)) {
        const callKind = classifyNetworkCall(inner, ctx);
        if (callKind !== null && !isHeadMethodCall(inner) && !isChainedDirectConsumeOrReturn(node)) {
          let holder: ts.Node = node;
          while (holder.parent && ts.isParenthesizedExpression(holder.parent)) {
            holder = holder.parent;
          }
          const parent = holder.parent;

          if (parent && ts.isVariableDeclaration(parent) && parent.initializer) {
            if (ts.isIdentifier(parent.name)) {
              allocations.push({
                kind: callKind,
                anchorNode: parent,
                creationNode: parent,
                responseNames: new Set([parent.name.text]),
                bodyNames: new Set()
              });
            } else if (ts.isObjectBindingPattern(parent.name)) {
              let boundBodyName: string | null = null;
              let restName: string | null = null;
              for (const el of parent.name.elements) {
                if (el.dotDotDotToken && ts.isIdentifier(el.name)) {
                  restName = el.name.text;
                  continue;
                }
                const propName =
                  el.propertyName && ts.isIdentifier(el.propertyName)
                    ? el.propertyName.text
                    : ts.isIdentifier(el.name)
                      ? el.name.text
                      : null;
                if (propName === 'body' && ts.isIdentifier(el.name)) {
                  boundBodyName = el.name.text;
                }
              }

              if (boundBodyName !== null) {
                allocations.push({
                  kind: callKind,
                  anchorNode: parent,
                  creationNode: parent,
                  responseNames: restName ? new Set([restName]) : new Set(),
                  bodyNames: new Set([boundBodyName])
                });
              } else if (restName !== null) {
                allocations.push({
                  kind: callKind,
                  anchorNode: parent,
                  creationNode: parent,
                  responseNames: new Set([restName]),
                  bodyNames: new Set()
                });
              } else {
                const ruleId = callKind === 'fetch' ? 'FRA001' : 'FRA002';
                const label = callKind === 'fetch' ? 'fetch()' : 'Undici request()';
                findings.push(
                  createFinding(
                    ctx.sourceFile,
                    fileLabel,
                    ruleId,
                    parent,
                    `${label} destructuring omits 'body', leaving the response body unreachable and unconsumed.`
                  )
                );
              }
            }
          } else if (
            parent &&
            ts.isBinaryExpression(parent) &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            unwrapExpression(parent.right) === node
          ) {
            const lhs = unwrapExpression(parent.left);
            if (ts.isIdentifier(lhs)) {
              allocations.push({
                kind: callKind,
                anchorNode: parent,
                creationNode: parent,
                responseNames: new Set([lhs.text]),
                bodyNames: new Set()
              });
            } else if (ts.isObjectLiteralExpression(lhs)) {
              let boundBody: string | null = null;
              for (const prop of lhs.properties) {
                if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'body') {
                  boundBody = prop.name.text;
                } else if (
                  ts.isPropertyAssignment(prop) &&
                  ts.isIdentifier(prop.name) &&
                  prop.name.text === 'body' &&
                  ts.isIdentifier(prop.initializer)
                ) {
                  boundBody = prop.initializer.text;
                }
              }
              if (boundBody !== null) {
                allocations.push({
                  kind: callKind,
                  anchorNode: parent,
                  creationNode: parent,
                  responseNames: new Set(),
                  bodyNames: new Set([boundBody])
                });
              } else {
                const ruleId = callKind === 'fetch' ? 'FRA001' : 'FRA002';
                const label = callKind === 'fetch' ? 'fetch()' : 'Undici request()';
                findings.push(
                  createFinding(
                    ctx.sourceFile,
                    fileLabel,
                    ruleId,
                    parent,
                    `${label} destructuring assignment omits 'body', leaving the response stream unconsumed.`
                  )
                );
              }
            }
          } else if (callKind === 'undici-request' && parent && ts.isExpressionStatement(parent)) {
            findings.push(
              createFinding(
                ctx.sourceFile,
                fileLabel,
                'FRA002',
                parent,
                `Undici request() response is discarded without consuming or calling body.dump().`
              )
            );
          }
        }
      }
    }

    ts.forEachChild(node, collectInScope);
  }

  for (const stmt of statements) {
    collectInScope(stmt);
  }

  for (const alloc of allocations) {
    const leak = simulateAllocationInScope(statements, alloc, ctx.sourceFile);
    if (leak !== null) {
      const ruleId = alloc.kind === 'fetch' ? 'FRA001' : 'FRA002';
      const apiLabel = alloc.kind === 'fetch' ? 'fetch()' : 'Undici request()';
      const hint =
        alloc.kind === 'fetch'
          ? 'Consume the body or call await res.body?.cancel() before exiting.'
          : 'Consume the body or call await body.dump() / cancel() before exiting.';
      findings.push(
        createFinding(
          ctx.sourceFile,
          fileLabel,
          ruleId,
          alloc.anchorNode,
          `${apiLabel} ${leak.reason}. ${hint}`
        )
      );
    }
  }
}

export function analyzeBodyLeaks(
  ctx: ModuleCallContext,
  fileLabel: string
): Finding[] {
  const findings: Finding[] = [];

  analyzeStatementScope(ctx.sourceFile.statements, ctx, fileLabel, findings);

  function visitFunctions(node: ts.Node): void {
    if (ts.isFunctionLike(node) && 'body' in node && node.body && ts.isBlock(node.body)) {
      analyzeStatementScope(node.body.statements, ctx, fileLabel, findings);
    }
    ts.forEachChild(node, visitFunctions);
  }

  ts.forEachChild(ctx.sourceFile, visitFunctions);
  return findings;
}
