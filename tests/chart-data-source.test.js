'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const {
    ChartDataSourceService,
    _test,
} = require('../modules/services/chartDataSourceService');

async function run() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-chart-data-source-'));
    const jsonPath = path.join(root, 'metrics.json');
    const csvPath = path.join(root, 'metrics.csv');
    const textPath = path.join(root, 'status.txt');
    const sqlitePath = path.join(root, 'metrics.db');

    await fs.writeFile(jsonPath, JSON.stringify({
        metrics: { cpu: 42.5, memory: 71 },
    }), 'utf8');
    await fs.writeFile(
        csvPath,
        'time,cpu,note\n1,42.5,"normal, load"\n2,63.2,"high ""burst"""\n',
        'utf8'
    );
    await fs.writeFile(textPath, 'running\nhealthy', 'utf8');

    const Database = require('better-sqlite3');
    const database = new Database(sqlitePath);
    database.exec(`
        CREATE TABLE samples (
            time INTEGER NOT NULL,
            cpu REAL NOT NULL
        );
        INSERT INTO samples (time, cpu) VALUES (1, 42.5), (2, 63.2);
    `);
    database.close();

    const service = new ChartDataSourceService({
        maxBytes: 1024 * 1024,
        timeoutMs: 1000,
        logger: { warn() {} },
    });

    const json = await service.read({
        type: 'json',
        source: pathToFileURL(jsonPath).toString(),
    });
    assert.strictEqual(json.type, 'json');
    assert.strictEqual(json.data.metrics.cpu, 42.5);
    assert.strictEqual(
        path.resolve(json.source).toLowerCase(),
        path.resolve(await fs.realpath(jsonPath)).toLowerCase()
    );

    const csv = await service.read({
        type: 'csv',
        source: csvPath,
    });
    assert.strictEqual(csv.data.length, 2);
    assert.deepStrictEqual(csv.data[0], {
        time: '1',
        cpu: '42.5',
        note: 'normal, load',
    });
    assert.strictEqual(csv.data[1].note, 'high "burst"');

    const text = await service.read({
        type: 'text',
        source: textPath,
    });
    assert.strictEqual(text.data, 'running\nhealthy');

    const sqlite = await service.read({
        type: 'sqlite',
        source: pathToFileURL(sqlitePath).toString(),
        sql: 'SELECT time, cpu FROM samples WHERE cpu > ? ORDER BY time',
        params: [50],
    });
    assert.strictEqual(sqlite.type, 'sqlite');
    assert.strictEqual(sqlite.rowCount, 1);
    assert.deepStrictEqual(sqlite.columns, ['time', 'cpu']);
    assert.deepStrictEqual(sqlite.data, [{ time: 2, cpu: 63.2 }]);

    const cte = await service.read({
        type: 'sqlite',
        source: sqlitePath,
        sql: 'WITH recent AS (SELECT * FROM samples) SELECT COUNT(*) AS count FROM recent',
    });
    assert.deepStrictEqual(cte.data, [{ count: 2 }]);

    await assert.rejects(
        service.read({
            type: 'sqlite',
            source: sqlitePath,
            sql: 'DELETE FROM samples',
        }),
        error => error.code === 'CHART_SQL_READ_ONLY_REQUIRED'
    );

    await assert.rejects(
        service.read({
            type: 'sqlite',
            source: sqlitePath,
            sql: 'SELECT * FROM samples; DROP TABLE samples;',
        }),
        error => error.code === 'CHART_SQL_MULTIPLE_STATEMENTS'
    );

    await assert.rejects(
        service.read({
            type: 'json',
            source: 'relative/data.json',
        }),
        error => error.code === 'CHART_DATA_SOURCE_ABSOLUTE_REQUIRED'
    );

    assert.deepStrictEqual(
        _test.parseCsv('a,b\n1,"x,y"\n'),
        [{ a: '1', b: 'x,y' }]
    );
    assert.strictEqual(
        _test.assertReadOnlySql('SELECT * FROM samples;'),
        'SELECT * FROM samples'
    );
    assert.throws(
        () => _test.assertReadOnlySql('PRAGMA table_info(samples)'),
        error => error.code === 'CHART_SQL_READ_ONLY_REQUIRED'
    );

    await fs.rm(root, { recursive: true, force: true });
    console.log('chart-data-source.test.js: all assertions passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});