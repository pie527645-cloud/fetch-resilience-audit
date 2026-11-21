import ts from 'typescript';
import { RULES } from '../rules/metadata.js';
import type { Finding, RuleId } from '../types.js';

export type NetworkCallKind = 'fetch' | 'undici-request';

const HTTP_FETCH_PACKAGES: ReadonlySet<string> = new Set([
  'undici',
  'node-fetch',
  'cross-fetch',
  'isomorphic-fetch',
  'whatwg-fetch'
]);

const UNDICI_DISPATCHER_NAMES: ReadonlySet<string> = new Set([
  'Client',
  'Pool',
  'Agent',
  'BalancedPool',
  'Dispatcher'
]);

const LIMITER_PACKAGE_SUBSTRINGS: readonly string[] = [
  'p-limit',
  'p-map',
  'p-queue',
  'throat',
  'bottleneck',
  'sema',
  'semaphore',
  'async-mutex'
];

export interface ModuleCallContext {
  sourceFile: ts.SourceFile;
  undiciFetchIdentifiers: Set<string>;
  nonHttpFetchIdentifiers: Set<string>;
  undiciRequestIdentifiers: Set<string>;
  undiciNamespaceIdentifiers: Set<string>;
  undiciDispatcherClasses: Set<string>;
  undiciDispatcherInstances: Set<string>;
  undiciThisFields: Set<string>;
  limiterIdentifiers: Set<string>;
}

export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
    } else if (ts.isNonNullExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function isRequireOfModule(expr: ts.Expression, expectedModule?: string): string | null {
  const unwrapped = unwrapExpression(expr);
  if (!ts.isCallExpression(unwrapped)) {
    return null;
  }
  const callee = unwrapExpression(unwrapped.expression);
  if (!ts.isIdentifier(callee) || callee.text !== 'require' || unwrapped.arguments.length !== 1) {
    return null;
  }
  const arg0 = unwrapped.arguments[0];
  if (!arg0 || !ts.isStringLiteralLike(arg0)) {
    return null;
  }
  if (expectedModule !== undefined && arg0.text !== expectedModule) {
    return null;
  }
  return arg0.text;
}

function isLimiterPackageName(specifier: string): boolean {
  const lower = specifier.toLowerCase();
  for (const sub of LIMITER_PACKAGE_SUBSTRINGS) {
    if (lower === sub || lower.includes(`/${sub}`) || lower.startsWith(`${sub}/`)) {
      return true;
    }
  }
  return false;
}

function isUndiciDispatcherConstruction(expr: ts.Expression, ctx: ModuleCallContext): boolean {
  const unwrapped = unwrapExpression(expr);
  if (!ts.isNewExpression(unwrapped)) {
    return false;
  }
  const target = unwrapExpression(unwrapped.expression);
  if (ts.isIdentifier(target)) {
    return ctx.undiciDispatcherClasses.has(target.text);
  }
  if (ts.isPropertyAccessExpression(target)) {
    const obj = unwrapExpression(target.expression);
    if (
      ts.isIdentifier(obj) &&
      ctx.undiciNamespaceIdentifiers.has(obj.text) &&
      UNDICI_DISPATCHER_NAMES.has(target.name.text)
    ) {
      return true;
    }
    if (isRequireOfModule(obj, 'undici') !== null && UNDICI_DISPATCHER_NAMES.has(target.name.text)) {
      return true;
    }
  }
  return false;
}

function hasUndiciDispatcherTypeNode(
  typeNode: ts.TypeNode | undefined,
  ctx: ModuleCallContext
): boolean {
  if (!typeNode) {
    return false;
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeName = typeNode.typeName;
    if (ts.isIdentifier(typeName) && ctx.undiciDispatcherClasses.has(typeName.text)) {
      return true;
    }
    if (ts.isQualifiedName(typeName)) {
      if (
        ts.isIdentifier(typeName.left) &&
        ctx.undiciNamespaceIdentifiers.has(typeName.left.text) &&
        UNDICI_DISPATCHER_NAMES.has(typeName.right.text)
      ) {
        return true;
      }
    }
  }
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    for (const member of typeNode.types) {
      if (hasUndiciDispatcherTypeNode(member, ctx)) {
        return true;
      }
    }
  }
  return false;
}

export function buildModuleCallContext(sourceFile: ts.SourceFile): ModuleCallContext {
  const ctx: ModuleCallContext = {
    sourceFile,
    undiciFetchIdentifiers: new Set<string>(),
    nonHttpFetchIdentifiers: new Set<string>(),
    undiciRequestIdentifiers: new Set<string>(),
    undiciNamespaceIdentifiers: new Set<string>(),
    undiciDispatcherClasses: new Set<string>(),
    undiciDispatcherInstances: new Set<string>(),
    undiciThisFields: new Set<string>(),
    limiterIdentifiers: new Set<string>()
  };

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      const modName = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (!clause) {
        continue;
      }

      const isUndici = modName === 'undici';
      const isHttpFetchPkg = HTTP_FETCH_PACKAGES.has(modName);
      const isLimiterPkg = isLimiterPackageName(modName);

      if (clause.name) {
        if (isUndici) {
          ctx.undiciNamespaceIdentifiers.add(clause.name.text);
        } else if (isHttpFetchPkg) {
          ctx.undiciFetchIdentifiers.add(clause.name.text);
        } else if (clause.name.text === 'fetch') {
          ctx.nonHttpFetchIdentifiers.add(clause.name.text);
        }
        if (isLimiterPkg) {
          ctx.limiterIdentifiers.add(clause.name.text);
        }
      }

      const bindings = clause.namedBindings;
      if (bindings) {
        if (ts.isNamespaceImport(bindings)) {
          if (isUndici) {
            ctx.undiciNamespaceIdentifiers.add(bindings.name.text);
          }
          if (isLimiterPkg) {
            ctx.limiterIdentifiers.add(bindings.name.text);
          }
        } else if (ts.isNamedImports(bindings)) {
          for (const elem of bindings.elements) {
            const importedName = elem.propertyName ? elem.propertyName.text : elem.name.text;
            const localName = elem.name.text;
            if (isUndici) {
              if (importedName === 'request') {
                ctx.undiciRequestIdentifiers.add(localName);
              } else if (importedName === 'fetch') {
                ctx.undiciFetchIdentifiers.add(localName);
              } else if (UNDICI_DISPATCHER_NAMES.has(importedName)) {
                ctx.undiciDispatcherClasses.add(localName);
              }
            } else if (isHttpFetchPkg && importedName === 'fetch') {
              ctx.undiciFetchIdentifiers.add(localName);
            } else if (localName === 'fetch') {
              ctx.nonHttpFetchIdentifiers.add(localName);
            }

            if (isLimiterPkg) {
              ctx.limiterIdentifiers.add(localName);
            }
          }
        }
      }
    }
  }

  function scanRequiresAndInstances(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer) {
        const reqMod = isRequireOfModule(node.initializer);
        if (reqMod !== null) {
          const isUndici = reqMod === 'undici';
          const isLimiter = isLimiterPackageName(reqMod);
          if (ts.isIdentifier(node.name)) {
            if (isUndici) {
              ctx.undiciNamespaceIdentifiers.add(node.name.text);
            }
            if (isLimiter) {
              ctx.limiterIdentifiers.add(node.name.text);
            }
          } else if (ts.isObjectBindingPattern(node.name)) {
            for (const el of node.name.elements) {
              if (!ts.isIdentifier(el.name)) {
                continue;
              }
              const propName =
                el.propertyName && ts.isIdentifier(el.propertyName)
                  ? el.propertyName.text
                  : el.name.text;
              const localName = el.name.text;
              if (isUndici) {
                if (propName === 'request') {
                  ctx.undiciRequestIdentifiers.add(localName);
                } else if (propName === 'fetch') {
                  ctx.undiciFetchIdentifiers.add(localName);
                } else if (UNDICI_DISPATCHER_NAMES.has(propName)) {
                  ctx.undiciDispatcherClasses.add(localName);
                }
              }
              if (isLimiter) {
                ctx.limiterIdentifiers.add(localName);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, scanRequiresAndInstances);
  }

  scanRequiresAndInstances(sourceFile);

  function scanInstancesAndLimiters(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (
        hasUndiciDispatcherTypeNode(node.type, ctx) ||
        (node.initializer && isUndiciDispatcherConstruction(node.initializer, ctx))
      ) {
        ctx.undiciDispatcherInstances.add(node.name.text);
      }

      if (node.initializer) {
        const init = unwrapExpression(node.initializer);
        if (ts.isCallExpression(init) || ts.isNewExpression(init)) {
          const callee = unwrapExpression(init.expression);
          if (ts.isIdentifier(callee) && ctx.limiterIdentifiers.has(callee.text)) {
            ctx.limiterIdentifiers.add(node.name.text);
          } else if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            ctx.limiterIdentifiers.has(callee.expression.text)
          ) {
            ctx.limiterIdentifiers.add(node.name.text);
          }
        }
      }
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      if (hasUndiciDispatcherTypeNode(node.type, ctx)) {
        ctx.undiciDispatcherInstances.add(node.name.text);
      }
    } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      if (
        hasUndiciDispatcherTypeNode(node.type, ctx) ||
        (node.initializer && isUndiciDispatcherConstruction(node.initializer, ctx))
      ) {
        ctx.undiciThisFields.add(node.name.text);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = unwrapExpression(node.left);
      if (
        ts.isPropertyAccessExpression(left) &&
        left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        isUndiciDispatcherConstruction(node.right, ctx)
      ) {
        ctx.undiciThisFields.add(left.name.text);
      } else if (ts.isIdentifier(left) && isUndiciDispatcherConstruction(node.right, ctx)) {
        ctx.undiciDispatcherInstances.add(left.text);
      }
    }

    ts.forEachChild(node, scanInstancesAndLimiters);
  }

  scanInstancesAndLimiters(sourceFile);
  return ctx;
}

function collectPatternBinding(
  nameNode: ts.BindingName,
  targetName: string,
  declOwner: ts.Node
): ts.Node | null {
  if (ts.isIdentifier(nameNode)) {
    return nameNode.text === targetName ? declOwner : null;
  }
  for (const elem of nameNode.elements) {
    if (ts.isOmittedExpression(elem)) {
      continue;
    }
    const found = collectPatternBinding(elem.name, targetName, elem);
    if (found) {
      return found;
    }
  }
  return null;
}

function findBindingInStatements(
  statements: readonly ts.Statement[],
  targetName: string
): ts.Node | null {
  for (const stmt of statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const found = collectPatternBinding(decl.name, targetName, decl);
        if (found) {
          return found;
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === targetName) {
      return stmt;
    } else if (ts.isClassDeclaration(stmt) && stmt.name?.text === targetName) {
      return stmt;
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const clause = stmt.importClause;
      if (clause.name?.text === targetName) {
        return clause;
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === targetName) {
          return clause.namedBindings;
        }
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const spec of clause.namedBindings.elements) {
            if (spec.name.text === targetName) {
              return spec;
            }
          }
        }
      }
    }
  }
  return null;
}

export function resolveLexicalDeclaration(
  fromNode: ts.Node,
  identifierName: string
): ts.Node | null {
  let current: ts.Node | undefined = fromNode.parent;
  while (current) {
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isModuleBlock(current)) {
      const found = findBindingInStatements(current.statements, identifierName);
      if (found) {
        return found;
      }
    } else if (ts.isCaseBlock(current)) {
      for (const clause of current.clauses) {
        const found = findBindingInStatements(clause.statements, identifierName);
        if (found) {
          return found;
        }
      }
    } else if (
      ts.isForStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isForInStatement(current)
    ) {
      if (current.initializer && ts.isVariableDeclarationList(current.initializer)) {
        for (const decl of current.initializer.declarations) {
          const found = collectPatternBinding(decl.name, identifierName, decl);
          if (found) {
            return found;
          }
        }
      }
    } else if (ts.isCatchClause(current) && current.variableDeclaration) {
      const found = collectPatternBinding(
        current.variableDeclaration.name,
        identifierName,
        current.variableDeclaration
      );
      if (found) {
        return found;
      }
    } else if (ts.isFunctionLike(current)) {
      for (const param of current.parameters) {
        const found = collectPatternBinding(param.name, identifierName, param);
        if (found) {
          return found;
        }
      }
      if (
        (ts.isFunctionExpression(current) || ts.isFunctionDeclaration(current)) &&
        current.name?.text === identifierName
      ) {
        return current;
      }
    }
    current = current.parent;
  }
  return null;
}

export function classifyNetworkCall(
  call: ts.CallExpression,
  ctx: ModuleCallContext
): NetworkCallKind | null {
  const callee = unwrapExpression(call.expression);

  if (ts.isIdentifier(callee)) {
    const name = callee.text;
    if (name === 'fetch' || ctx.undiciFetchIdentifiers.has(name)) {
      const decl = resolveLexicalDeclaration(callee, name);
      if (ctx.undiciFetchIdentifiers.has(name)) {
        if (!decl || ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isBindingElement(decl)) {
          return 'fetch';
        }
      }
      if (name === 'fetch' && !ctx.nonHttpFetchIdentifiers.has(name) && decl === null) {
        return 'fetch';
      }
    }

    if (ctx.undiciRequestIdentifiers.has(name)) {
      const decl = resolveLexicalDeclaration(callee, name);
      if (!decl || ts.isImportSpecifier(decl) || ts.isBindingElement(decl)) {
        return 'undici-request';
      }
    }
    return null;
  }

  if (ts.isPropertyAccessExpression(callee)) {
    const prop = callee.name.text;
    const obj = unwrapExpression(callee.expression);

    if (prop === 'fetch') {
      if (ts.isIdentifier(obj)) {
        if (obj.text === 'globalThis' || obj.text === 'window' || obj.text === 'self') {
          return 'fetch';
        }
        if (ctx.undiciNamespaceIdentifiers.has(obj.text)) {
          return 'fetch';
        }
      }
      if (isRequireOfModule(obj, 'undici') !== null) {
        return 'fetch';
      }
      return null;
    }

    if (prop === 'request') {
      if (ts.isIdentifier(obj)) {
        if (ctx.undiciNamespaceIdentifiers.has(obj.text)) {
          return 'undici-request';
        }
        if (ctx.undiciDispatcherInstances.has(obj.text)) {
          return 'undici-request';
        }
      }
      if (
        ts.isPropertyAccessExpression(obj) &&
        obj.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ctx.undiciThisFields.has(obj.name.text)
      ) {
        return 'undici-request';
      }
      if (isUndiciDispatcherConstruction(obj, ctx)) {
        return 'undici-request';
      }
      if (isRequireOfModule(obj, 'undici') !== null) {
        return 'undici-request';
      }
    }
  }

  return null;
}

function objectLiteralHasHeadMethod(objLit: ts.ObjectLiteralExpression): boolean {
  for (const prop of objLit.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const key =
        ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : null;
      if (key === 'method') {
        const val = unwrapExpression(prop.initializer);
        if (ts.isStringLiteralLike(val) && val.text.toUpperCase() === 'HEAD') {
          return true;
        }
      }
    }
  }
  return false;
}

export function isHeadMethodCall(call: ts.CallExpression): boolean {
  for (const arg of call.arguments) {
    const unwrapped = unwrapExpression(arg);
    if (ts.isObjectLiteralExpression(unwrapped) && objectLiteralHasHeadMethod(unwrapped)) {
      return true;
    }
    if (ts.isIdentifier(unwrapped)) {
      const decl = resolveLexicalDeclaration(unwrapped, unwrapped.text);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = unwrapExpression(decl.initializer);
        if (ts.isObjectLiteralExpression(init) && objectLiteralHasHeadMethod(init)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function isDescendantOf(node: ts.Node, potentialAncestor: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (current === potentialAncestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function isLoopNode(
  node: ts.Node
): node is
  | ts.ForStatement
  | ts.ForOfStatement
  | ts.ForInStatement
  | ts.WhileStatement
  | ts.DoStatement {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

export function createFinding(
  sourceFile: ts.SourceFile,
  fileLabel: string,
  ruleId: RuleId,
  node: ts.Node,
  message: string
): Finding {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    ruleId,
    severity: RULES[ruleId].severity,
    message,
    file: fileLabel,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1
  };
}
