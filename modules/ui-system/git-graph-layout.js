/**
 * modules/ui-system/git-graph-layout.js
 * Git 图谱的泳道布局：把按拓扑序排列的提交算成每行的节点坐标和连线路径。
 *
 * 移植自 ZCode（https://github.com/zai-org/ZCode，Apache-2.0）的
 * packages/ui/src/git-graph/layout.ts 与 layoutAlgorithm.ts，去掉类型声明后保持算法不变。
 */

'use strict';

const MISSING_PARENT_ID = -1;

class LayoutBranch {
    constructor(colourIndex) {
        this.colourIndex = colourIndex;
        this.lines = [];
        this.endRowIndex = 0;
    }

    addLine(from, to, sourceHash, targetHash, lockedFirst) {
        this.lines.push({ from, to, laneIndex: this.colourIndex, sourceHash, targetHash, lockedFirst });
    }
}

class LayoutVertex {
    constructor(id, hash) {
        this.id = id;
        this.hash = hash;
        this.parents = [];
        this.nextParentIndex = 0;
        this.laneIndex = null;
        this.branch = null;
        this.nextLaneIndex = 0;
        this.connections = [];
    }

    addParent(vertex) { this.parents.push(vertex); }
    getNextParent() { return this.nextParentIndex < this.parents.length ? this.parents[this.nextParentIndex] : null; }
    registerParentProcessed() { this.nextParentIndex++; }
    isMerge() { return this.parents.length > 1; }
    isNotOnBranch() { return this.branch === null || this.laneIndex === null; }

    addToBranch(branch, laneIndex) {
        if (this.branch === null) {
            this.branch = branch;
            this.laneIndex = laneIndex;
        }
    }

    getBranch() { return this.branch; }
    getLaneIndex() { return this.laneIndex ?? 0; }
    getPoint() { return { laneIndex: this.getLaneIndex(), rowIndex: this.id }; }
    getNextPoint() { return { laneIndex: this.nextLaneIndex, rowIndex: this.id }; }

    getPointConnectingTo(target, branch) {
        const index = this.connections.findIndex(connection => connection?.target === target && connection.branch === branch);
        return index >= 0 ? { laneIndex: index, rowIndex: this.id } : null;
    }

    reservePoint(laneIndex, target, branch) {
        if (laneIndex === this.nextLaneIndex) {
            this.connections[laneIndex] = { target, branch };
            this.nextLaneIndex = laneIndex + 1;
        }
    }

    getWidthLaneIndex() { return this.nextLaneIndex; }
}

function createVertices(commits) {
    const missingParent = new LayoutVertex(MISSING_PARENT_ID, '__missing_parent__');
    const vertices = commits.map((commit, index) => new LayoutVertex(index, commit.hash));
    const vertexByHash = new Map(vertices.map(vertex => [vertex.hash, vertex]));
    commits.forEach((commit, index) => {
        for (const parentHash of commit.parents) vertices[index].addParent(vertexByHash.get(parentHash) ?? missingParent);
    });
    return { missingParent, vertices, vertexByHash };
}

function getAvailableColour(startAt, availableColours) {
    const reusable = availableColours.findIndex(endAt => startAt > endAt);
    if (reusable >= 0) return reusable;
    availableColours.push(0);
    return availableColours.length - 1;
}

function determineMergePath(startAt, vertices, vertex, parentVertex) {
    const parentBranch = parentVertex.getBranch();
    let lastPoint = vertex.getPoint();
    for (let rowIndex = startAt + 1; rowIndex < vertices.length; rowIndex++) {
        const current = vertices[rowIndex];
        const existing = current.getPointConnectingTo(parentVertex, parentBranch);
        const currentPoint = existing ?? current.getNextPoint();
        const found = existing !== null;
        parentBranch.addLine(
            lastPoint,
            currentPoint,
            vertex.hash,
            parentVertex.hash,
            !found && current !== parentVertex ? lastPoint.laneIndex < currentPoint.laneIndex : true
        );
        current.reservePoint(currentPoint.laneIndex, parentVertex, parentBranch);
        lastPoint = currentPoint;
        if (found) {
            vertex.registerParentProcessed();
            break;
        }
    }
}

function determineNormalPath({ startAt, vertices, branches, availableColours, missingParent }) {
    let rowIndex = startAt;
    let vertex = vertices[rowIndex];
    let parentVertex = vertex.getNextParent();
    let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint();
    const branch = new LayoutBranch(getAvailableColour(startAt, availableColours));
    vertex.addToBranch(branch, lastPoint.laneIndex);
    vertex.reservePoint(lastPoint.laneIndex, vertex, branch);

    for (rowIndex = startAt + 1; rowIndex < vertices.length; rowIndex++) {
        if (parentVertex === null || parentVertex === missingParent) break;
        const current = vertices[rowIndex];
        const currentPoint = parentVertex === current && !parentVertex.isNotOnBranch() ? current.getPoint() : current.getNextPoint();
        branch.addLine(lastPoint, currentPoint, vertex.hash, parentVertex.hash, lastPoint.laneIndex < currentPoint.laneIndex);
        current.reservePoint(currentPoint.laneIndex, parentVertex, branch);
        lastPoint = currentPoint;
        if (parentVertex === current) {
            vertex.registerParentProcessed();
            const parentWasAlreadyOnBranch = !parentVertex.isNotOnBranch();
            parentVertex.addToBranch(branch, currentPoint.laneIndex);
            vertex = parentVertex;
            parentVertex = vertex.getNextParent();
            if (parentVertex === missingParent) {
                // 分页窗口外的 parent 没有可见节点，不能继续把线画到窗口底部
                vertex.registerParentProcessed();
                break;
            }
            if (parentVertex === null || parentWasAlreadyOnBranch) break;
        }
    }

    branch.endRowIndex = rowIndex;
    branches.push(branch);
    availableColours[branch.colourIndex] = rowIndex;
}

function determinePath(params) {
    const vertex = params.vertices[params.startAt];
    const parentVertex = vertex.getNextParent();
    if (parentVertex === params.missingParent) {
        // 分页窗口外的 parent：节点自己仍要落到一条泳道上，否则外层循环永远等不到它上线
        if (vertex.isNotOnBranch()) {
            const point = vertex.getNextPoint();
            const branch = new LayoutBranch(getAvailableColour(params.startAt, params.availableColours));
            vertex.addToBranch(branch, point.laneIndex);
            vertex.reservePoint(point.laneIndex, vertex, branch);
            branch.endRowIndex = params.startAt;
            params.branches.push(branch);
            params.availableColours[branch.colourIndex] = params.startAt;
        }
        vertex.registerParentProcessed();
        return;
    }
    if (parentVertex !== null && vertex.isMerge() && !vertex.isNotOnBranch() && !parentVertex.isNotOnBranch()) {
        determineMergePath(params.startAt, params.vertices, vertex, parentVertex);
        return;
    }
    determineNormalPath(params);
}

export function createGitGraphLayoutModel(commits) {
    const { missingParent, vertices, vertexByHash } = createVertices(commits);
    const branches = [];
    const availableColours = [];
    let index = 0;
    while (index < vertices.length) {
        const vertex = vertices[index];
        if (vertex.getNextParent() !== null || vertex.isNotOnBranch()) {
            determinePath({ startAt: index, vertices, branches, availableColours, missingParent });
        } else {
            index++;
        }
    }
    return { vertices, vertexByHash, branchLines: branches.flatMap(branch => branch.lines) };
}

const DEFAULT_ROW_HEIGHT = 42;
const DEFAULT_LANE_GAP = 18;
const DEFAULT_LANE_PADDING = 16;
const DEFAULT_TOP_PADDING = 20;
const DEFAULT_BOTTOM_PADDING = 18;

function buildEdgePath({ fromX, fromY, toX, toY, lockedFirst }) {
    if (fromX === toX) return `M ${fromX} ${fromY} L ${toX} ${toY}`;
    const curveOffset = Math.max(14, Math.abs(toY - fromY) * 0.38);
    if (lockedFirst === false) {
        return `M ${fromX} ${fromY} C ${fromX} ${toY - curveOffset}, ${toX} ${toY - curveOffset}, ${toX} ${toY}`;
    }
    return `M ${fromX} ${fromY} C ${fromX} ${fromY + curveOffset}, ${toX} ${fromY + curveOffset}, ${toX} ${toY}`;
}

function pointToPixels(point, options) {
    return {
        x: options.lanePadding + point.laneIndex * options.laneGap,
        y: options.topPadding + point.rowIndex * options.rowHeight
    };
}

function createGraphPath(line, lineIndex, pixelOptions) {
    const from = pointToPixels(line.from, pixelOptions);
    const to = pointToPixels(line.to, pixelOptions);
    return {
        id: `${line.sourceHash}:${line.targetHash}:${line.from.rowIndex}:${line.to.rowIndex}:${lineIndex}:path`,
        laneIndex: line.laneIndex,
        path: buildEdgePath({ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, lockedFirst: line.lockedFirst }),
        relatedHashes: line.sourceHash === line.targetHash ? [line.sourceHash] : [line.sourceHash, line.targetHash]
    };
}

export function layoutGitGraph(commits, options = {}) {
    const rowHeight = options.rowHeight ?? DEFAULT_ROW_HEIGHT;
    const laneGap = options.laneGap ?? DEFAULT_LANE_GAP;
    const lanePadding = options.lanePadding ?? DEFAULT_LANE_PADDING;
    const topPadding = options.topPadding ?? DEFAULT_TOP_PADDING;
    const bottomPadding = options.bottomPadding ?? DEFAULT_BOTTOM_PADDING;
    const { vertices, branchLines } = createGitGraphLayoutModel(commits);

    const rows = vertices.map((vertex, rowIndex) => {
        const laneIndex = vertex.getLaneIndex();
        return { commit: commits[rowIndex], rowIndex, laneIndex, x: lanePadding + laneIndex * laneGap, y: topPadding + rowIndex * rowHeight };
    });
    const maxRowLane = rows.reduce((max, row) => Math.max(max, row.laneIndex), 0);
    const maxWidthLane = vertices.reduce((max, vertex) => Math.max(max, vertex.getWidthLaneIndex() - 1), 0);
    const maxLineLane = branchLines.reduce((max, line) => Math.max(max, line.from.laneIndex, line.to.laneIndex), 0);
    const laneCount = Math.max(1, maxRowLane + 1, maxWidthLane + 1, maxLineLane + 1);
    const pixelOptions = { lanePadding, laneGap, topPadding, rowHeight };

    return {
        rows,
        paths: branchLines.map((line, index) => createGraphPath(line, index, pixelOptions)),
        laneCount,
        width: lanePadding * 2 + (laneCount - 1) * laneGap,
        height: topPadding + Math.max(0, commits.length - 1) * rowHeight + bottomPadding,
        rowHeight,
        laneGap
    };
}

/** `git log --format=%D` 的装饰串（"HEAD -> main"、"tag: v1"、"origin/main"）转成图谱标签 */
export function parseGraphRefs(refs) {
    const result = [];
    for (const raw of refs || []) {
        const text = String(raw).trim();
        if (!text) continue;
        if (text.startsWith('HEAD -> ')) {
            result.push({ name: text.slice(8), kind: 'head' });
        } else if (text === 'HEAD') {
            result.push({ name: 'HEAD', kind: 'head' });
        } else if (text.startsWith('tag: ')) {
            result.push({ name: text.slice(5), kind: 'tag' });
        } else {
            result.push({ name: text, kind: text.includes('/') ? 'remote' : 'branch' });
        }
    }
    return result;
}
