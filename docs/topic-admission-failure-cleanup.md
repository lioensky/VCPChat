# 前端失败清理契约（2026-11-12）

替代 phase1 中“失败后 uncertain 保留占用、终稿核验后恢复”的策略。

- 网络可靠性由 VCPToolbox / VCPAPI 负责；前端收到失败即结束当前本地轮次。
- fail 与兼容入口 reportUncertain 统一清除指定话题的租约、持久租约账本与全部暂挂；不删除聊天历史，不自动重试、不自动推进暂挂。
- 必须匹配当前 token；迟到旧轮失败不得解除新轮租约。
- 失败时同话题等待预约以 ADMISSION_FAILED 拒绝，不能在失败后接力生成。
- 日志写入失败仍清除内存占用并报告错误；磁盘残留在启动恢复时清理。
- 启动发现 standalone lease、advancing、uncertain、failed、lease-diagnostic，清理该话题全部暂挂，不再核对终稿；其他纯暂挂话题保持 recovered、等待明确继续。
- 已接收的部分回答仍尽力保存；失败清理不以保存成功作为先决条件。
- 流式 transport failed 在 afterPersist 清理；投影/持久化失败在 onSettled 兜底。
- 正常 completed 与用于工具边界交接的 cancelled 路径保持既有契约。

工程 p7o8h。当前仅源码施工，未部署客户端运行目录。验收状态以工程报告为准。