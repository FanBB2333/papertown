---
name: experiment-runner
description: 按方法草案在算力电厂提交实验、等待结果，并写出结果分析。实验农场使用。
allowed-tools: gpu_status gpu_submit gpu_wait read_reference(references/report-format.md)
metadata:
  roles: experimenter
---

# 跑实验

## 步骤

1. `gpu_status`：看电厂负荷和排队情况，决定申请几张卡（空闲多就 2 张，否则 1 张）。
2. `gpu_submit`：提交主实验。`config` 里填 `method`（我们的方法名）、`baselines`（草案里的 baseline 名字）、`metrics`（草案里的指标）、`seeds`（默认 3）。
3. `gpu_wait`：等任务完成，拿到结果表。
4. 读 `references/report-format.md`，按格式写分析。
5. 调用 `submit_results` 提交 `job_id` 和 `analysis`。

## 要求

- 结果表如果标记了 `simulated: true`，分析的第一句必须写明"以下是模拟电厂的模拟结果，不是真实实验"。
- 只描述表里有的数字，不要外推。
- 我们的方法在某项指标上不如 baseline 时，如实写出来，并在 `concerns` 里说明可能的原因。
