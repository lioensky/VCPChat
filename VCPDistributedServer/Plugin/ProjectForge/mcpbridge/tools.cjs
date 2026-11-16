'use strict';

const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validators = new WeakMap();
const text = { type: 'string' };
const nonempty = { type: 'string', minLength: 1, pattern: '\\S' };
const boolean = { type: 'boolean' };
const positive = { type: 'integer', minimum: 1 };
const natural = { type: 'integer', minimum: 0 };
const enumeration = (...values) => ({ type: 'string', enum: values });
const list = { anyOf: [nonempty, { type: 'array', minItems: 1, items: nonempty }] };
const reference = { anyOf: [positive, nonempty] };
const edge = { anyOf: [natural, nonempty] };
const range = enumeration('full', 'body');
const scope = enumeration('project', 'workspace');
const project = { projectId: nonempty };
const signature = { maid: { type: 'string', description: '默认由桥配置注入。' } };
const operation = { operationId: { ...nonempty, maxLength: 128 } };
const sequence = { type: 'string', pattern: '^\\s*#?[1-9][0-9]*(?:\\s*[,\\n]\\s*#?[1-9][0-9]*)*\\s*$' };
const sequences = { anyOf: [sequence, { type: 'array', minItems: 1, items: { anyOf: [positive, { type: 'string', pattern: '^#?[1-9][0-9]*$' }] } }] };
const todo = { anyOf: [positive, ...sequences.anyOf] };
const write = { ...project, reason: nonempty, todo };
const syntax = { revertOnSyntaxError: boolean };
const object = (properties, required = [], constraints = {}) => ({
    type: 'object', properties, required, additionalProperties: false, ...constraints,
});
const has = (...fields) => ({ anyOf: fields.map(field => ({ required: [field] })) });
const exclusive = (...fields) => ({ oneOf: fields.map(field => ({ required: [field] })) });
const block = {
    target: nonempty, start: positive, end: positive, lines: nonempty,
    symbol: nonempty, range, line: positive, pick: positive, expect: text,
};
const stepFields = {
    op: enumeration('replace', 'delete', 'symbol', 'insert', 'target'),
    start: positive, end: positive, lines: nonempty, after: edge, before: edge,
    content: text, target: nonempty, replace: text, expect: text, line: positive,
    pick: { anyOf: [positive, nonempty, { type: 'array', minItems: 1, items: positive }] },
    symbol: nonempty, range,
};
const step = object({ ...stepFields, reason: nonempty, todo }, [],
    has('op', 'target', 'start', 'symbol', 'lines', 'after', 'before'));
const relocation = {
    ...write, ...syntax, from: nonempty, to: nonempty, ...block,
    block: object(block), after: edge, before: edge,
    indent: { anyOf: [natural, nonempty] }, create: boolean,
};
const projectFilter = { workspace: nonempty, query: nonempty, limit: positive, includeDeleted: boolean };

function tool(command, description, properties = {}, required = [], readOnly = false, constraints = {}) {
    return {
        name: `pf_${command.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`,
        command,
        description,
        inputSchema: object({ ...properties, ...signature, ...(!readOnly ? operation : {}) }, required, constraints),
        annotations: {
            readOnlyHint: readOnly,
            destructiveHint: !readOnly,
            idempotentHint: false,
            openWorldHint: command === 'EvalSymbol',
        },
    };
}

// Capability filtering belongs to the server, not this complete command catalog.
const tools = [
    tool('ListWorkspaces', '列出工作区。', {}, [], true),
    tool('CreateProject', '创建工程；路径相对工程根。', {
        name: nonempty, workspace: nonempty, dir: text, todos: list,
    }, ['name']),
    tool('ListProjects', '列出工程，默认最新10个；workspace可为all。', projectFilter, [], true),
    tool('SearchProjects', '搜索指定工作区工程；workspace不能为all。', {
        ...projectFilter, workspace: { ...nonempty, not: { pattern: '^[aA][lL][lL]$' } },
    }, ['workspace', 'query'], true),
    tool('GetProject', '读取工程、待办与最近脉络。', {
        ...project, timeline: positive,
    }, ['projectId'], true),
    tool('UpdateTodos', '更新待办；列表为序号；seq配title/note。', {
        ...project, add: list, done: sequences, doing: sequences, pending: sequences,
        blocked: sequences, remove: sequences, seq: positive, title: nonempty, note: text,
    }, ['projectId'], false, {
        anyOf: [
            ...['add', 'done', 'doing', 'pending', 'blocked', 'remove'].map(field => ({ required: [field] })),
            { required: ['seq'], ...has('title', 'note') },
        ],
        dependencies: { title: ['seq'], note: ['seq'] },
    }),
    tool('SubmitReport', '提交验收结论及遗留问题。', {
        ...project, conclusion: nonempty, issues: text, status: enumeration('review', 'accepted', 'active'),
    }, ['projectId', 'conclusion']),
    tool('DeleteProjects', '软删工程记录，不改磁盘。', { projectIds: list }, ['projectIds']),
    tool('RestoreProjects', '恢复软删工程。', { projectIds: list }, ['projectIds']),
    tool('PurgeProjects', '永久清除已软删工程及快照，不改磁盘。', {
        projectIds: list, confirm: { type: 'boolean', const: true },
    }, ['projectIds', 'confirm']),
    tool('ReadCode', '读文件/多模态；path支持:M-N或#符号；find搜索；lines支持head:N/tail:N/M-N。', {
        ...project, path: nonempty, paths: list, glob: nonempty, lines: nonempty,
        find: nonempty, showLine: boolean, symbol: nonempty, range,
        context: natural, pick: positive, line: positive,
    }, ['projectId'], true, {
        ...has('path', 'paths', 'glob'), dependencies: { symbol: ['path'] },
    }),
    tool('Outline', '列文件符号大纲。', {
        ...project, path: nonempty, paths: list, depth: positive, kind: list,
    }, ['projectId'], true, has('path', 'paths')),
    tool('FindSymbol', '按名称定位符号；工作区外结果只读。', {
        ...project, name: nonempty, kind: text, glob: nonempty, exact: boolean,
        limit: positive, scope,
    }, ['projectId', 'name'], true),
    tool('Trace', '链路地图；target为ipc:/api:/global:/page:/file:。', {
        ...project, target: nonempty, scope, glob: nonempty,
    }, ['projectId', 'target'], true),
    tool('EditCode', '主用非空edits数组，同一原快照、重叠拒绝；也支持平铺单步。path=file#symbol不向数组注入symbol，数组每项须自带symbol。range=body保留前注释；target省略replace会删除；歧义用ResolveEdit。', {
        ...write, ...syntax,
        path: nonempty,
        edits: { type: 'array', minItems: 1, items: step },
        ...stepFields,
        mode: enumeration('atomic', 'bestEffort'),
        expectedHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        drift: natural,
    }, ['projectId', 'path', 'reason'], false, {
        anyOf: [
            { required: ['edits'] },
            has('op', 'target', 'start', 'symbol', 'lines', 'after', 'before'),
            { required: ['content'], properties: { path: { type: 'string', pattern: '#.+' } } },
        ],
    }),
    tool('ResolveEdit', '选择歧义票据；pick如2、1,3、all或2:1;5:3。', {
        ticketId: nonempty, pick: reference,
    }, ['ticketId', 'pick']),
    tool('CreateFile', '创建文件；覆盖须overwrite=true，旧内容存快照。', {
        ...write, ...syntax, path: nonempty, content: text, overwrite: boolean,
    }, ['projectId', 'path', 'content', 'reason']),
    tool('RemoveFile', '删除文件并保留快照，可回退。', {
        ...write, path: nonempty, paths: list,
    }, ['projectId', 'reason'], false, has('path', 'paths')),
    tool('MoveFile', '移动或重命名文件；目标须不存在。', {
        ...write, from: nonempty, to: nonempty,
    }, ['projectId', 'from', 'to', 'reason']),
    tool('MoveCode', '剪切代码块；from支持:M-N/#符号；to默认同文件；after/before定位。',
        relocation, ['projectId', 'from', 'reason']),
    tool('CopyCode', '复制代码块；from支持:M-N/#符号；to默认同文件；after/before定位。',
        relocation, ['projectId', 'from', 'reason']),
    tool('Rollback', '回退批次或节点；dryRun预演，force覆盖冲突并保留快照。', {
        ...project, batch: reference, toNode: reference, path: nonempty,
        reason: nonempty, dryRun: boolean, force: boolean,
    }, ['projectId'], false, exclusive('batch', 'toNode')),
    tool('SearchHistory', '搜索改动历史；byMaid按署名过滤。', {
        ...project, file: nonempty, keyword: nonempty, content: nonempty, byMaid: nonempty,
        todo: reference, op: enumeration('create', 'edit', 'delete', 'move', 'rollback', 'external'),
        batch: reference, since: nonempty, until: nonempty, limit: positive,
    }, [], true, { dependencies: { todo: ['projectId'] } }),
    tool('GetNodeDiff', '查看节点或批次diff。', {
        ...project, node: reference, batch: reference, maxLines: positive,
    }, ['projectId'], true, exclusive('node', 'batch')),
    tool('EvalSymbol', '执行可信工程代码，非沙箱，可写盘联网；JS/Python函数或Rust已有测试。args与setup互斥，kwargs仅Python；testPick为Rust测试消歧。', {
        ...project, path: nonempty, symbol: nonempty, pick: positive, line: positive,
        args: { type: 'array', items: {} },
        kwargs: { type: 'object', additionalProperties: true },
        setup: text, timeoutMs: { ...positive, maximum: 110000 },
        package: nonempty, features: list, target: nonempty, testPick: positive,
    }, ['projectId', 'path'], false, {
        allOf: [
            { anyOf: [{ required: ['symbol'] }, { properties: { path: { type: 'string', pattern: '#.+' } } }] },
            { not: { required: ['args', 'setup'] } },
        ],
    }),
];

function validateArguments(tool, args) {
    const definition = typeof tool === 'string'
        ? tools.find(entry => entry.name === tool || entry.command === tool)
        : tool;
    if (!definition || !definition.inputSchema) throw new Error(`Unknown ProjectForge tool: ${String(tool)}`);
    let validate = validators.get(definition);
    if (!validate) {
        validate = ajv.compile(definition.inputSchema);
        validators.set(definition, validate);
    }
    if (!validate(args)) {
        const details = validate.errors.map(error => {
            const location = error.instancePath || error.dataPath || '/';
            return `${location}: ${error.message} (${JSON.stringify(error.params)})`;
        }).join('; ');
        throw new Error(`Invalid arguments for ${definition.name || definition.command}: ${details}`);
    }
    return args;
}

module.exports = { tools, validateArguments };
