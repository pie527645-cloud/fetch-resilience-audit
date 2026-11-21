import ts from 'typescript';
import type { Finding } from '../types.js';
import {
  classifyNetworkCall,
  createFinding,
  isDescendantOf,
  isLoopNode,
  resolveLexicalDeclaration,
  unwrapExpression,
  type ModuleCallContext
} from './astUtils.js';

interface TimeoutOrigin {
  originNode: ts.Node;
  kind: 'signal' | 'options';
}

function isAbortSignalObject(expr: ts.Expression): boolean {
  const u = unwrapExpression(expr);
  if (ts.isIdentifier(u) && u.text === 'AbortSignal') {
    return true;
  }
  if (ts.isPropertyAccessExpression(u) && u.name.text === 'AbortSignal') {
    const obj = unwrapExpression(u.expression);
    if (
      ts.isIdentifier(obj) &&
      (obj.text === 'globalThis' || obj.text === 'window' || obj.text === 'self')
    ) {
      return true;
    }
  }
  return false;
}

function isDirectAbortSignalTimeoutCall(expr: ts.Expression): boolean {
  const u = unwrapExpression(expr);
  if (!ts.isCallExpression(u)) {
    return false;
  }
  const callee = unwrapExpression(u.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === 'timeout' && isAbortSignalObject(callee.expression)) {
      return true;
    }
    if (
      callee.name.text === 'any' &&
      isAbortSignalObject(callee.expression) &&
      u.arguments.length >= 1
    ) {
      const arg0 = u.arguments[0];
      if (arg0) {
        const arr = unwrapExpression(arg0);
        if (ts.isArrayLiteralExpression(arr)) {
          for (const el of arr.elements) {
            if (!ts.isOmittedExpression(el) && !ts.isSpreadElement(el)) {
              if (isDirectAbortSignalTimeoutCall(el)) {
                return true;
              }
            }
          }
        }
      }
    }
  }
  return false;
}

function findAssignedTimeoutInScope(
  decl: ts.VariableDeclaration,
  sourceFile: ts.SourceFile
): TimeoutOrigin | null {
  if (!ts.isIdentifier(decl.name)) {
    return null;
  }
  const targetName = decl.name.text;
  let scopeRoot: ts.Node = sourceFile;
  let cur: ts.Node | undefined = decl.parent;
  while (cur) {
    if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur)) {
      scopeRoot = cur;
      break;
    }
    cur = cur.parent;
  }

  let found: TimeoutOrigin | null = null;
  function scan(node: ts.Node): void {
    if (found) {
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const lhs = unwrapExpression(node.left);
      if (ts.isIdentifier(lhs) && lhs.text === targetName) {
        const resolved = resolveLexicalDeclaration(lhs, targetName);
        if (resolved === decl) {
          if (isDirectAbortSignalTimeoutCall(node.right)) {
            found = { originNode: node.right, kind: 'signal' };
            return;
          }
          const rhs = unwrapExpression(node.right);
          if (ts.isObjectLiteralExpression(rhs)) {
            const objOrigin = extractObjectLiteralTimeoutOrigin(rhs, sourceFile, new Set([decl]));
            if (objOrigin) {
              found = objOrigin;
              return;
            }
          }
        }
      }
    }
    ts.forEachChild(node, scan);
  }

  scan(scopeRoot);
  return found;
}

function extractObjectLiteralTimeoutOrigin(
  objLit: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  visited: Set<ts.Node>
): TimeoutOrigin | null {
  for (const prop of objLit.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key =
        ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : null;
      if (key === 'signal') {
        const val = unwrapExpression(prop.initializer);
        if (isDirectAbortSignalTimeoutCall(val)) {
          return { originNode: val, kind: 'options' };
        }
        if (ts.isIdentifier(val)) {
          const sigDecl = resolveLexicalDeclaration(val, val.text);
          if (sigDecl) {
            const sub = getTimeoutBindingOrigin(sigDecl, sourceFile, visited);
            if (sub && sub.kind === 'signal') {
              return { originNode: sub.originNode, kind: 'options' };
            }
          }
        }
      }
    } else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'signal') {
      const sigDecl = resolveLexicalDeclaration(prop, 'signal');
      if (sigDecl) {
        const sub = getTimeoutBindingOrigin(sigDecl, sourceFile, visited);
        if (sub && sub.kind === 'signal') {
          return { originNode: sub.originNode, kind: 'options' };
        }
      }
    } else if (ts.isSpreadAssignment(prop)) {
      const spreadTarget = unwrapExpression(prop.expression);
      if (ts.isIdentifier(spreadTarget)) {
        const baseDecl = resolveLexicalDeclaration(spreadTarget, spreadTarget.text);
        if (baseDecl) {
          const sub = getTimeoutBindingOrigin(baseDecl, sourceFile, visited);
          if (sub && sub.kind === 'options') {
            return { originNode: sub.originNode, kind: 'options' };
          }
        }
      }
    }
  }
  return null;
}

function getTimeoutBindingOrigin(
  declNode: ts.Node,
  sourceFile: ts.SourceFile,
  visited: Set<ts.Node> = new Set()
): TimeoutOrigin | null {
  if (visited.has(declNode)) {
    return null;
  }
  visited.add(declNode);

  if (ts.isVariableDeclaration(declNode)) {
    if (declNode.initializer) {
      const init = unwrapExpression(declNode.initializer);
      if (isDirectAbortSignalTimeoutCall(init)) {
        return { originNode: init, kind: 'signal' };
      }
      if (ts.isIdentifier(init)) {
        const targetDecl = resolveLexicalDeclaration(init, init.text);
        if (targetDecl) {
          return getTimeoutBindingOrigin(targetDecl, sourceFile, visited);
        }
      }
      if (ts.isCallExpression(init)) {
        const callee = unwrapExpression(init.expression);
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'any' &&
          isAbortSignalObject(callee.expression) &&
          init.arguments.length >= 1
        ) {
          const arg0 = init.arguments[0];
          if (arg0) {
            const arr = unwrapExpression(arg0);
            if (ts.isArrayLiteralExpression(arr)) {
              for (const el of arr.elements) {
                if (ts.isIdentifier(el)) {
                  const subDecl = resolveLexicalDeclaration(el, el.text);
                  if (subDecl) {
                    const sub = getTimeoutBindingOrigin(subDecl, sourceFile, visited);
                    if (sub && sub.kind === 'signal') {
                      return { originNode: sub.originNode, kind: 'signal' };
                    }
                  }
                }
              }
            }
          }
        }
      }
      if (ts.isObjectLiteralExpression(init)) {
        const objOrigin = extractObjectLiteralTimeoutOrigin(init, sourceFile, visited);
        if (objOrigin) {
          return objOrigin;
        }
      }
    }
    return findAssignedTimeoutInScope(declNode, sourceFile);
  }

  return null;
}

function isReassignedFreshInLoopBeforeCall(
  loopBody: ts.Statement,
  varName: string,
  declNode: ts.Node,
  callNode: ts.CallExpression
): boolean {
  let reassignedFresh = false;
  const callStart = callNode.getStart();

  function scan(node: ts.Node): void {
    if (reassignedFresh || node.getStart() >= callStart) {
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const lhs = unwrapExpression(node.left);
      if (ts.isIdentifier(lhs) && lhs.text === varName) {
        const resolved = resolveLexicalDeclaration(lhs, varName);
        if (resolved === declNode && isDirectAbortSignalTimeoutCall(node.right)) {
          reassignedFresh = true;
          return;
        }
      }
    }
    ts.forEachChild(node, scan);
  }

  scan(loopBody);
  return reassignedFresh;
}

function getEnclosingLoops(
  node: ts.Node
): Array<ts.ForStatement | ts.ForOfStatement | ts.ForInStatement | ts.WhileStatement | ts.DoStatement> {
  const loops: Array<
    ts.ForStatement | ts.ForOfStatement | ts.ForInStatement | ts.WhileStatement | ts.DoStatement
  > = [];
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isLoopNode(cur)) {
      loops.push(cur);
    }
    cur = cur.parent;
  }
  return loops;
}

export function analyzeLoopSignals(
  ctx: ModuleCallContext,
  fileLabel: string
): Finding[] {
  const findings: Finding[] = [];

  function checkIdentifierUsageInLoop(
    usageNode: ts.Node,
    identName: string,
    expectedKind: 'signal' | 'options',
    callNode: ts.CallExpression,
    loops: ReturnType<typeof getEnclosingLoops>
  ): boolean {
    const decl = resolveLexicalDeclaration(usageNode, identName);
    if (!decl) {
      return false;
    }
    const origin = getTimeoutBindingOrigin(decl, ctx.sourceFile);
    if (!origin || origin.kind !== expectedKind) {
      return false;
    }

    for (const loop of loops) {
      if (!isDescendantOf(origin.originNode, loop.statement)) {
        if (!isReassignedFreshInLoopBeforeCall(loop.statement, identName, decl, callNode)) {
          const originLine =
            ctx.sourceFile.getLineAndCharacterOfPosition(origin.originNode.getStart(ctx.sourceFile))
              .line + 1;
          findings.push(
            createFinding(
              ctx.sourceFile,
              fileLabel,
              'FRA003',
              callNode,
              `Identifier '${identName}' carries an AbortSignal.timeout() created outside the loop (line ${originLine}), sharing a single expiring or pre-aborted signal across iterations.`
            )
          );
          return true;
        }
      }
    }
    return false;
  }

  function inspectCallInLoop(
    callNode: ts.CallExpression,
    loops: ReturnType<typeof getEnclosingLoops>
  ): void {
    for (const arg of callNode.arguments) {
      const uArg = unwrapExpression(arg);

      if (ts.isIdentifier(uArg)) {
        if (checkIdentifierUsageInLoop(uArg, uArg.text, 'options', callNode, loops)) {
          return;
        }
      } else if (ts.isObjectLiteralExpression(uArg)) {
        for (const prop of uArg.properties) {
          if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'signal') {
            if (checkIdentifierUsageInLoop(prop, 'signal', 'signal', callNode, loops)) {
              return;
            }
          } else if (ts.isPropertyAssignment(prop)) {
            const key =
              ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)
                ? prop.name.text
                : null;
            if (key === 'signal') {
              const val = unwrapExpression(prop.initializer);
              if (ts.isIdentifier(val)) {
                if (checkIdentifierUsageInLoop(val, val.text, 'signal', callNode, loops)) {
                  return;
                }
              } else if (
                ts.isPropertyAccessExpression(val) &&
                val.name.text === 'signal'
              ) {
                const obj = unwrapExpression(val.expression);
                if (ts.isIdentifier(obj)) {
                  if (checkIdentifierUsageInLoop(obj, obj.text, 'options', callNode, loops)) {
                    return;
                  }
                }
              } else if (ts.isCallExpression(val)) {
                const callee = unwrapExpression(val.expression);
                if (
                  ts.isPropertyAccessExpression(callee) &&
                  callee.name.text === 'any' &&
                  isAbortSignalObject(callee.expression) &&
                  val.arguments.length >= 1
                ) {
                  const arrArg = val.arguments[0];
                  if (arrArg) {
                    const arr = unwrapExpression(arrArg);
                    if (ts.isArrayLiteralExpression(arr)) {
                      for (const el of arr.elements) {
                        const uEl = ts.isOmittedExpression(el) ? null : unwrapExpression(el);
                        if (uEl && ts.isIdentifier(uEl)) {
                          if (checkIdentifierUsageInLoop(uEl, uEl.text, 'signal', callNode, loops)) {
                            return;
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          } else if (ts.isSpreadAssignment(prop)) {
            const spreadExpr = unwrapExpression(prop.expression);
            if (ts.isIdentifier(spreadExpr)) {
              if (checkIdentifierUsageInLoop(spreadExpr, spreadExpr.text, 'options', callNode, loops)) {
                return;
              }
            }
          }
        }
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const kind = classifyNetworkCall(node, ctx);
      if (kind !== null) {
        const loops = getEnclosingLoops(node);
        if (loops.length > 0) {
          inspectCallInLoop(node, loops);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(ctx.sourceFile);
  return findings;
}
