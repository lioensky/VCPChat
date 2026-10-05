import { parse } from '@babel/parser';

const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const scopeNodes = new Set(['Program', 'BlockStatement', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement']);
const isNode = value => value && typeof value.type === 'string';
const children = node => Object.values(node).flatMap(value => Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []);
const memberName = node => {
    if (node?.type === 'Identifier') return node.name;
    if (node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression') {
        if (!node.computed && node.property.type === 'Identifier') return node.property.name;
        if (node.computed && node.property.type === 'StringLiteral') return node.property.value;
    }
    return null;
};
const isMember = node => node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression';
const isIpcReceiver = node => /^(?:ipcMain|ipcRenderer)(?:Ref)?$/.test(memberName(node) || '') || ['webContents', 'sender'].includes(memberName(node));

function patternNames(pattern) {
    if (!pattern) return [];
    if (pattern.type === 'Identifier') return [pattern.name];
    if (pattern.type === 'RestElement') return patternNames(pattern.argument);
    if (pattern.type === 'AssignmentPattern') return patternNames(pattern.left);
    if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(patternNames);
    if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap(property => patternNames(property.type === 'RestElement' ? property.argument : property.value));
    return [];
}

function indexScopes(ast) {
    const scopes = new WeakMap(), nodes = [];
    function visit(node, parentScope) {
        if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
            if (node.id) parentScope.bindings.set(node.id.name, { value: node.type === 'FunctionDeclaration' ? node : null, scope: parentScope });
        }
        let scope = parentScope;
        if (functions.has(node.type) || scopeNodes.has(node.type)) {
            scope = { parent: parentScope, function: functions.has(node.type) || node.type === 'Program', owner: node, bindings: new Map() };
        }
        scopes.set(node, scope);
        nodes.push(node);
        if (functions.has(node.type)) {
            for (const param of node.params) for (const name of patternNames(param)) scope.bindings.set(name, { value: null });
            if (node.type === 'FunctionExpression' && node.id) scope.bindings.set(node.id.name, { value: null });
        }
        if (node.type === 'CatchClause') for (const name of patternNames(node.param)) scope.bindings.set(name, { value: null });
        if (node.type === 'ImportDeclaration') for (const specifier of node.specifiers) scope.bindings.set(specifier.local.name, {
            value: null, scope, ipc: node.source.value === 'electron' && specifier.type === 'ImportSpecifier'
                && ['ipcRenderer', 'ipcMain'].includes(specifier.imported.name) ? specifier.imported.name : null,
        });
        if (node.type === 'VariableDeclaration') {
            let target = scope;
            if (node.kind === 'var') while (target.parent && !target.function) target = target.parent;
            for (const declaration of node.declarations) for (const name of patternNames(declaration.id)) {
                const electronRequire = node.kind === 'const' && declaration.init?.type === 'CallExpression'
                    && declaration.init.callee.type === 'Identifier' && declaration.init.callee.name === 'require'
                    && declaration.init.arguments.length === 1 && declaration.init.arguments[0].value === 'electron';
                const property = declaration.id.type === 'ObjectPattern' ? declaration.id.properties.find(item =>
                    item.type === 'ObjectProperty' && !item.computed && item.value.type === 'Identifier' && item.value.name === name) : null;
                target.bindings.set(name, { value: node.kind === 'const' && declaration.id.type === 'Identifier' ? declaration.init : null,
                    scope, ipc: electronRequire && ['ipcRenderer', 'ipcMain'].includes(property?.key.name) ? property.key.name : null,
                    electronRequire });
            }
        }
        for (const child of children(node)) visit(child, scope);
    }
    visit(ast.program, { parent: null, function: true, bindings: new Map() });
    function binding(name, scope) {
        for (let current = scope; current; current = current.parent) if (current.bindings.has(name)) return current.bindings.get(name);
        return null;
    }
    for (const node of nodes) {
        if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
            for (const name of patternNames(node.left || node.argument)) {
                const found = binding(name, scopes.get(node));
                if (found) { found.value = null; found.mutated = true; }
            }
        }
    }
    const unknown = () => ({ values: new Set(), complete: false });
    const literal = value => typeof value === 'string' ? { values: new Set([value]), complete: true } : unknown();
    // Bound branch expansion while retaining the fact that analysis is partial.
    const limit = 64;
    function combine(left, right, concatenate) {
        const values = new Set();
        let complete = left.complete && right.complete;
        const add = value => {
            if (values.has(value)) return;
            if (values.size < limit) values.add(value);
            else complete = false;
        };
        if (concatenate) for (const a of left.values) for (const b of right.values) add(a + b);
        else for (const value of [...left.values, ...right.values]) add(value);
        return { values, complete };
    }
    function stringValues(node, scope, seen = new Set()) {
        if (node?.type === 'StringLiteral') return literal(node.value);
        if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return literal(node.quasis[0].value.cooked);
        if (node?.type === 'ConditionalExpression') {
            return combine(stringValues(node.consequent, scope, seen), stringValues(node.alternate, scope, seen), false);
        }
        if (node?.type === 'BinaryExpression' && node.operator === '+') {
            return combine(stringValues(node.left, scope, seen), stringValues(node.right, scope, seen), true);
        }
        if (node?.type === 'Identifier') {
            const found = binding(node.name, scope);
            if (!found?.value || seen.has(found)) return unknown();
            return stringValues(found.value, found.scope, new Set([...seen, found]));
        }
        return unknown();
    }
    function stringValue(node, scope) {
        const { values, complete } = stringValues(node, scope);
        return complete && values.size === 1 ? [...values][0] : null;
    }
    return { nodes, scopes, binding, stringValue, stringValues };
}

// Infer only a local, immutable function's direct Electron operation. A nested
// callback or returned closure is a separate invocation; do not attribute it to
// the outer caller. Helper names alone carry no protocol meaning.
function localWrapperOperations({ nodes, scopes, binding }) {
    const operations = new WeakMap();
    for (const node of nodes) {
        if (node.type !== 'CallExpression' || !isMember(node.callee) || node.callee.object.type !== 'Identifier') continue;
        const receiver = binding(node.callee.object.name, scopes.get(node));
        if (!receiver?.ipc || receiver.mutated || (receiver.electronRequire && binding('require', receiver.scope))) continue;
        const method = memberName(node.callee);
        const role = ['on', 'once', 'handle'].includes(method) ? 'consumers' : ['send', 'invoke'].includes(method) ? 'producers' : null;
        if (!role || (method === 'handle' && receiver.ipc !== 'ipcMain')) continue;
        const channel = node.arguments[0];
        if (channel?.type !== 'Identifier') continue;
        let scope = scopes.get(node);
        while (scope && !scope.function) scope = scope.parent;
        const fn = scope?.owner;
        if (!fn || !functions.has(fn.type)) continue;
        const index = fn.params.findIndex(param => param.type === 'Identifier' && param.name === channel.name);
        if (index < 0) continue;
        const parameter = binding(channel.name, scope);
        if (parameter?.mutated || binding(channel.name, scopes.get(node)) !== parameter) continue;
        const values = operations.get(fn) || [];
        values.push({ index, role, kind: role === 'consumers' ? 'event-listener' : 'event-send' });
        operations.set(fn, values);
    }
    return (callee, scope, seen = new Set()) => {
        if (callee?.type !== 'Identifier') return [];
        let found = binding(callee.name, scope);
        while (found?.value?.type === 'Identifier' && !found.mutated && !seen.has(found)) {
            seen.add(found); found = binding(found.value.name, found.scope);
        }
        return !found?.mutated && found?.value ? operations.get(found.value) || [] : [];
    };
}

export function isChatEventName(name) {
    return typeof name === 'string' && name.length >= 2 && !/^https?:/.test(name) && !/\s|[\u3400-\u9fff]/.test(name)
        && (/(?:vcp|chat|stream|theme|history|topic|notification|appearance|flowlock|desktop|message|electron|plugin|surface|terminal|settings|assistant|voice|rust|push|cancel|retry|attachment|window|modal|conversation|selection|preload|ipc|^main\/|^agent\/|^session\/)/i.test(name) || name.includes('/'));
}

// Source inventory, not type inference or execution. Only immutable lexical
// strings are resolved; imported names and runtime values remain explicit.
export function scanChatEventSource({ file, source, dynamicRegistrations = [], subscriptionNames = new Set() }) {
    const ast = parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, plugins: ['jsx'] });
    const index = indexScopes(ast);
    const { nodes, scopes, stringValue, stringValues } = index;
    const wrapperOperations = localWrapperOperations(index);
    const events = [], registeredDynamic = [], undiscovered = [];
    function record(node, argument, role, kind, reason, domainOnly = false) {
        const { values, complete } = stringValues(argument, scopes.get(node));
        const line = node.loc.start.line;
        const match = source.slice(node.start, argument?.end ?? node.end).replace(/\r\n/g, '\n');
        const registration = dynamicRegistrations.find(site => site.file === file && site.line === line
            && (site.kind || 'custom-event-create') === kind
            && (site.match === undefined || site.match === match));
        for (const name of values) {
            if (!domainOnly || isChatEventName(name)) events.push({ name, role, file, line, kind, match });
        }
        const entry = { file, line, reason: complete ? reason : `${reason}: ${argument ? source.slice(argument.start, argument.end) : '<missing>'}` };
        // A known branch never excuses an unknown sibling or a truncated set.
        // Reviewed sites remain observed when their complete value becomes known.
        if (registration) registeredDynamic.push({ ...entry, kind, match, contractId: registration.contractId });
        else if (!complete) undiscovered.push(entry);
    }
    for (const node of nodes) {
        if (node.type === 'NewExpression' && ['CustomEvent', 'CustomEventConstructor'].includes(memberName(node.callee))) {
            record(node, node.arguments[0], 'producers', 'custom-event-create', 'dynamic CustomEvent name');
            continue;
        }
        if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') continue;
        const name = memberName(node.callee);
        const operations = wrapperOperations(node.callee, scopes.get(node));
        if (operations.length) {
            for (const operation of operations) record(node, node.arguments[operation.index], operation.role, operation.kind, 'dynamic local IPC wrapper channel');
            continue;
        }
        if (/^preloads\/api\//.test(file) && !isMember(node.callee) && ['on', 'onArgs', 'onSignal', 'send', 'invoke', 'custom'].includes(name)) {
            const customKind = name === 'custom' ? stringValue(node.arguments[0], scopes.get(node)) : null;
            const argument = node.arguments[name === 'custom' ? 1 : 0];
            // custom(..., null, ...) declares an API without an IPC channel.
            if (name === 'custom' && argument?.type === 'NullLiteral') continue;
            record(node, argument, name.startsWith('on') || customKind === 'subscription' ? 'consumers' : 'producers', 'preload-channel-definition', 'dynamic preload channel');
        }
        else if (name === 'addEventListener' && isMember(node.callee)) record(node, node.arguments[0], 'consumers', 'custom-event-listener', 'dynamic listener name');
        else if (isMember(node.callee) && (name === 'on' || name === 'once' || (name === 'handle' && isIpcReceiver(node.callee.object)))) record(node, node.arguments[0], 'consumers', 'event-listener', 'dynamic event listener name');
        else if (isMember(node.callee) && (name === 'invoke' || (name === 'send' && (isIpcReceiver(node.callee.object)
            || isChatEventName(stringValue(node.arguments[0], scopes.get(node))))))) record(node, node.arguments[0], 'producers', 'event-send', 'dynamic event name');
        else if (name === 'emit' || name === 'dispatch') {
            // Generic helpers also use emit(payload), dispatch(element, ...).
            // A static domain name is a candidate; unknown payloads are not IPC.
            const value = stringValue(node.arguments[0], scopes.get(node));
            if (typeof value === 'string') record(node, node.arguments[0], 'producers', 'event-send', 'dynamic event name', true);
        }
        else if (isMember(node.callee) && subscriptionNames.has(name)) {
            events.push({ name: `${name}(`, role: 'consumers', file, line: node.loc.start.line, kind: 'preload-subscription', match: source.slice(node.start, node.callee.end) + '(' });
        } else if (name === 'terminal' || name === 'finish' || name === 'complete') {
            const terminal = stringValue(node.arguments[0], scopes.get(node));
            if (['completed', 'failed', 'cancelled', 'aborted', 'discarded', 'error'].includes(terminal)) {
                events.push({ name: terminal, role: 'producers', file, line: node.loc.start.line, kind: 'stream-terminal', match: source.slice(node.start, node.arguments[0].end) });
            }
        }
    }
    return { events, registeredDynamic, undiscovered };
}
