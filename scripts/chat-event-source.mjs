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
            if (node.id) parentScope.bindings.set(node.id.name, { value: null });
        }
        let scope = parentScope;
        if (functions.has(node.type) || scopeNodes.has(node.type)) {
            scope = { parent: parentScope, function: functions.has(node.type) || node.type === 'Program', bindings: new Map() };
        }
        scopes.set(node, scope);
        nodes.push(node);
        if (functions.has(node.type)) {
            for (const param of node.params) for (const name of patternNames(param)) scope.bindings.set(name, { value: null });
            if (node.type === 'FunctionExpression' && node.id) scope.bindings.set(node.id.name, { value: null });
        }
        if (node.type === 'CatchClause') for (const name of patternNames(node.param)) scope.bindings.set(name, { value: null });
        if (node.type === 'ImportDeclaration') for (const specifier of node.specifiers) scope.bindings.set(specifier.local.name, { value: null });
        if (node.type === 'VariableDeclaration') {
            let target = scope;
            if (node.kind === 'var') while (target.parent && !target.function) target = target.parent;
            for (const declaration of node.declarations) for (const name of patternNames(declaration.id)) {
                target.bindings.set(name, { value: node.kind === 'const' && declaration.id.type === 'Identifier' ? declaration.init : null, scope });
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
                if (found) found.value = null;
            }
        }
    }
    function stringValue(node, scope, seen = new Set()) {
        if (node?.type === 'StringLiteral') return node.value;
        if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
        if (node?.type === 'BinaryExpression' && node.operator === '+') {
            const left = stringValue(node.left, scope, seen), right = stringValue(node.right, scope, seen);
            return typeof left === 'string' && typeof right === 'string' ? left + right : null;
        }
        if (node?.type === 'Identifier') {
            const found = binding(node.name, scope);
            if (!found?.value || seen.has(found)) return null;
            return stringValue(found.value, found.scope, new Set([...seen, found]));
        }
        return null;
    }
    return { nodes, scopes, stringValue };
}

export function isChatEventName(name) {
    return typeof name === 'string' && name.length >= 2 && !/^https?:/.test(name) && !/\s|[\u3400-\u9fff]/.test(name)
        && (/(?:vcp|chat|stream|theme|history|topic|notification|appearance|flowlock|desktop|message|electron|plugin|surface|terminal|settings|assistant|voice|rust|push|cancel|retry|attachment|window|modal|conversation|selection|preload|ipc|^main\/|^agent\/|^session\/)/i.test(name) || name.includes('/'));
}

// Source inventory, not type inference or execution. Only immutable lexical
// strings are resolved; imported names and runtime values remain explicit.
export function scanChatEventSource({ file, source, dynamicRegistrations = [], subscriptionNames = new Set() }) {
    const ast = parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, plugins: ['jsx'] });
    const { nodes, scopes, stringValue } = indexScopes(ast);
    const events = [], registeredDynamic = [], undiscovered = [];
    function record(node, argument, role, kind, reason, domainOnly = false) {
        const name = stringValue(argument, scopes.get(node));
        const line = node.loc.start.line;
        const registration = dynamicRegistrations.find(site => site.file === file && site.line === line
            && (site.kind || 'custom-event-create') === kind);
        if (typeof name === 'string') {
            if (!domainOnly || isChatEventName(name)) events.push({ name, role, file, line, kind, match: source.slice(node.start, argument?.end ?? node.end) });
            // Keep observing reviewed sites whose const value is now known.
            if (registration) registeredDynamic.push({ file, line, kind, reason, contractId: registration.contractId });
        } else {
            const entry = { file, line, reason: `${reason}: ${argument ? source.slice(argument.start, argument.end) : '<missing>'}` };
            if (registration) registeredDynamic.push({ ...entry, kind, contractId: registration.contractId });
            else undiscovered.push(entry);
        }
    }
    for (const node of nodes) {
        if (node.type === 'NewExpression' && ['CustomEvent', 'CustomEventConstructor'].includes(memberName(node.callee))) {
            record(node, node.arguments[0], 'producers', 'custom-event-create', 'dynamic CustomEvent name');
            continue;
        }
        if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') continue;
        const name = memberName(node.callee);
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
