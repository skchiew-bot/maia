import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';

export type Surface = 'operator' | 'portal' | 'standalone';

export interface RouteEntry {
  /** Full path pattern, e.g. `/sessions/:id`, `/portal`, `*` patterns as `/…/*`. */
  path: string;
  surface: Surface;
  /** Lazy page component (`ControlTowerPage`), or null for redirects such as the role landing. */
  component: string | null;
  /** Page module relative to packages/web/src (`pages/tower/ControlTowerPage.tsx`). */
  file: string | null;
  /** Roles named by the innermost `RequireRole` around the route; null = public. */
  roles: readonly string[] | null;
}

const ROLE_CONSTANTS: Record<string, readonly string[]> = {
  OPERATOR_ROLES: ['approver', 'builder'],
  ALL_ROLES: ['approver', 'builder', 'requester'],
};

/**
 * Reads the route table from routes.tsx (TypeScript AST, no rendering): every `<Route>` with its full path,
 * the layout it sits in, the lazily imported page it renders and the roles that guard it. New routes are
 * picked up without touching the harness.
 */
export function readRoutes(routesFile: string): RouteEntry[] {
  const source = ts.createSourceFile(
    routesFile,
    readFileSync(routesFile, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const lazyPages = new Map<string, string>();
  const out: RouteEntry[] = [];

  const visitLazy = (node: ts.Node) => {
    // const X = lazy(() => import('./pages/a/XPage'));
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const text = node.initializer.getText(source);
      const m = /^lazy\(\s*\(\)\s*=>\s*import\(\s*['"](.+?)['"]\s*\)\s*\)$/s.exec(text);
      if (m) lazyPages.set(node.name.text, `${posix.normalize(m[1]!.replace(/^\.\//, ''))}.tsx`);
    }
    ts.forEachChild(node, visitLazy);
  };
  visitLazy(source);

  const attr = (el: ts.JsxOpeningLikeElement, name: string) =>
    el.attributes.properties.find(
      (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === name,
    );

  const identifiersIn = (node: ts.Node): string[] => {
    const ids: string[] = [];
    const walk = (n: ts.Node) => {
      if (ts.isIdentifier(n)) ids.push(n.text);
      ts.forEachChild(n, walk);
    };
    walk(node);
    return ids;
  };

  /** `roles={['approver']}` or `roles={OPERATOR_ROLES}` on a RequireRole inside the element expression. */
  const rolesIn = (node: ts.Node): readonly string[] | null => {
    let found: readonly string[] | null = null;
    const walk = (n: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
        n.tagName.getText(source) === 'RequireRole'
      ) {
        const init = attr(n, 'roles')?.initializer;
        const expr = init && ts.isJsxExpression(init) ? init.expression : undefined;
        if (expr && ts.isArrayLiteralExpression(expr))
          found = expr.elements.filter(ts.isStringLiteral).map((e) => e.text);
        else if (expr && ts.isIdentifier(expr)) found = ROLE_CONSTANTS[expr.text] ?? null;
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
  };

  const visitRoutes = (
    node: ts.Node,
    ctx: { path: string; surface: Surface; roles: readonly string[] | null },
  ) => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (!opening || opening.tagName.getText(source) !== 'Route') {
      ts.forEachChild(node, (child) => visitRoutes(child, ctx));
      return;
    }
    const pathAttr = attr(opening, 'path')?.initializer;
    const ownPath = pathAttr && ts.isStringLiteral(pathAttr) ? pathAttr.text : null;
    const isIndex = attr(opening, 'index') !== undefined;
    const element = attr(opening, 'element')?.initializer;
    const ids = element ? identifiersIn(element) : [];

    const path =
      ownPath === null ? ctx.path : ownPath.startsWith('/') ? ownPath : posix.join(ctx.path, ownPath);
    const surface: Surface = ids.includes('OperatorLayout')
      ? 'operator'
      : ids.includes('PortalLayout')
        ? 'portal'
        : ctx.surface;
    const roles = (element && rolesIn(element)) ?? ctx.roles;
    const component = ids.find((id) => lazyPages.has(id)) ?? null;

    if (component || (isIndex && element)) {
      out.push({
        path: path === '' ? '/' : path,
        surface,
        component,
        file: component ? lazyPages.get(component)! : null,
        roles,
      });
    }
    if (ts.isJsxElement(node)) {
      for (const child of node.children) visitRoutes(child, { path, surface, roles });
    }
  };
  visitRoutes(source, { path: '/', surface: 'standalone', roles: null });
  return out;
}
