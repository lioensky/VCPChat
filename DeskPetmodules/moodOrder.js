/* 桌宠收到的持续心情排先后：主进程每次广播加一的 seq 说了算，和侧栏一样。
 * 不用 updatedAt：系统时间被往回调以后，新心情的时间会比旧的早，按时间比就会一直被丢掉。
 * 查询（get）返回的是当时的 seq，比它早发出、晚到的查询结果不会盖掉已经推过来的新心情。 */
export function createMoodOrder(agentId) {
    let lastSeq = 0;
    return function accept(mood) {
        if (!mood || mood.agentId !== agentId) return false;
        const seq = Number(mood.seq) || 0;
        if (seq < lastSeq) return false;
        lastSeq = seq;
        return true;
    };
}
