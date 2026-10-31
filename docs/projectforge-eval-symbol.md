# EvalSymbol：Agent 原生函数试跑

目标：鲁棒、易用、省 token、省步骤、易懂、确定性。统一验证意图与证据回执，不伪造跨语言执行语义。

## 调用

ProjectForge command=EvalSymbol，必需 projectId、path=文件#符号。

| 参数 | 语义 |
| --- | --- |
| args | JSON 参数数组，默认 [] |
| kwargs | Python 关键字参数对象，默认 {} |
| setup | JS/Python 异步准备函数体，返回参数数组，与 args 互斥 |
| timeoutMs | JS/Py 默认 5000，Rust 默认 100000，范围 1..110000 |
| pick / line | AST 同名符号消歧 |
| package / features | Rust Cargo 包与 feature |
| target / testPick | Rust 编译产物测试目标过滤 / 运行时测试候选选择 |

示例（字段为工具参数）：

```text
command: EvalSymbol
projectId: <工程ID>
path: src/math.py#normalize
args: [[3,4]]
```

```text
command: EvalSymbol
projectId: <工程ID>
path: src/lib.rs#tests.handles_zero
```

JS setup 示例：`return [Buffer.from("abc")];`。
Python setup 示例：`return [module.Input(3)]`。
setup 只准备输入，不替换目标模块词法绑定，不提供自动 mock。

## 执行配置

工程根 `.projectforge-eval.json` 可包含：

```json
{
  "node": "node",
  "python": ".venv/Scripts/python.exe",
  "cargo": "cargo"
}
```

带路径分隔符的配置值相对工程根解析；裸命令从 PATH 解析。字段分别可选。

Python 优先工程配置、工程根 .venv、PATH（Windows python.exe / 其他 python3）。选择后失败不回退，回执记录来源与实际解释器版本。
JS 默认宿主可执行文件的 Node 模式，清空 NODE_OPTIONS；支持真实 CommonJS/ESM 导出及对象方法 this。
Python 支持常规包相对导入；不自动推测 namespace package、构建系统 import mapping 或任意 src-layout 安装。
TS、宿主 Electron/DOM 现场、局部闭包与自动构造实例暂不支持。

## Rust v1

仅执行已有标准 libtest 测试；不自动提取/编译普通函数。
在目标文件至工程根间寻找最近 Cargo.toml，离线编译测试产物，列出测试，再精确执行唯一匹配。
匹配常规文件模块路径；自定义 #[path]、include!、宏生成模块、custom harness 不保证支持，不以猜测替代缺失信息。
Cargo 可能生成/更新 Cargo.lock 和 target 产物；build.rs、过程宏仍可产生副作用。offline 不等于网络安全隔离。
零命中、ignored、零实际执行都不返回 passed。

普通 Rust 函数临时 harness 后续单独实现：公开 API 可外部 harness；私有符号需合法模块作用域下的受控副本/覆盖层，不向真实源码临时插入代码。
该阶段尚未交付。

## 回执证据

- returned：函数成功返回，不代表执行了测试断言。
- passed：Rust 标准测试报告恰好执行一个测试且通过。
- test_failed / not_executed：断言失败 / 未实际执行。
- load_error / setup_error / execution_error / encoding_error：按阶段区分。
- timeout / environment_error / protocol_error / source_changed / result_limit / output_limit：不伪装普通成功。

details 包含目标源码 hash（不是依赖指纹）、运行时、耗时、检查计数与日志。
JS/Python 返回值采用 typed-v1：普通数组与标量保留；对象用
`{"$type":"object","entries":[["key",value]]}`；
undefined、BigInt、非有限数值、Python tuple 显式标记。
循环结构、复杂实例、访问器等无法无损表达时拒绝编码，请函数显式返回 JSON 投影。

stdout/stderr 各保留最多 64 KiB，超限继续排空并标记截断；结构化结果最多 1 MiB。
正常文本简报不展开日志；失败展示相关尾部，完整有界日志在 details。
文本 value 最多 2000 字符，截断明确提示。
每次执行使用独立进程，不复用模块缓存。目标文件执行前后检查 hash，不代表依赖被冻结。

## 权限与生命周期

这是可信工程执行器，不是安全沙箱。
必须具有可写工程权限；目标 realpath 不得越出工程根。导入、setup、被测代码都可能写文件、联网和启动进程。
不通过 shell 执行命令；总执行截止时间覆盖 worker 加载、setup、调用和结果传输，Rust 覆盖编译/列举/执行。
超时使用进程树终止，插件 cleanup 请求中止活动执行。
不承诺撤销副作用，也不承诺恶意代码不能伪造输出。

## 验证与部署

```powershell
node --test tests/project-forge-eval.test.js tests/project-forge-eval-integration.test.js
```

施工源码：H:\VCP\VCPMain\VCPChat。
运行客户端：H:\MCP\VCPChat。源码测试通过不等于运行插件已部署或热加载。
发布必须包含新增 JS/CJS/Python worker 与 manifest，并按现有插件生命周期重载。