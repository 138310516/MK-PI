# 一人公司（one-person-company）

单机协作骨架。公司按岗位收发**信封**，不把长报告塞进消息，也不把各岗对话镜像进一个总上下文。v0 在一台机器上跑通：初始化目录、校验并投递信封、用文件 watch 叫醒岗位、占位岗读一张任务单后回执。

后期运行时打算接 [Pi](https://github.com/earendil-works/pi)（MIT）。这一版不接模型，只用占位岗把契约跑通。

## v0 做了什么

- `opc init`：写下 `company.yaml`，并建好下面的目录树。
- 信封只有这些字段：`id`、`from`、`to`、`task_id`、`type`、`priority`、`body`、`created_at`。
  - `type`：`dispatch` | `result-ready` | `merge-ready`。没有催办，也没有 `nudge`。
  - `priority`：`immediate` | `normal`。
  - `from` / `to`：`role@site`。
  - `body`：公司根目录里的**相对文件路径**。路径不对、带换行、或写成一段报告，都会被拒绝。
- 同一个 `id` 再投一次会被忽略，不会再执行。
- 信箱按 maildir 的方式落盘：先写入 `mailbox/tmp/`，fsync 之后 **rename** 进 `mailbox/new/`。处理时改名到 `cur/`，成功到 `done/`，失败到 `failed/`。
- `mailbox/seen/` 是 id 台账。信被改名挪走之后，重复 id 仍然认得出。watch 不盯这个目录。
- `opc watch` 对每个 `mailbox/new/` 做 `fs.watch`。写完即叫醒，不把轮询当主路。
- 占位岗（`worker` / `merge`）收到 `dispatch` 后只读这一张任务单，写下 `out/<task-id>/` 和短存档 `archive/<task-id>.md`，再投递 `result-ready`。回执的 `body` 指向存档路径。
- 传话岗和知识岗在 v0 不执行任务单。`result-ready` 和 `merge-ready` 只签收进 `done/`。

## 这一版不做

- 不接 Pi 的模型循环
- 不做看盘 UI
- 不做 NATS，也不做跨机器投递
- 不做知识岗核对（`init` 会建 `knowledge/inbox|accepted|rejected`）
- 不做传话岗自动拆单或合并调度。派单用 `opc send` 手动投

## 目录

```
<root>/
  company.yaml
  clerk/
    mailbox/          # tmp/ new/ cur/ done/ failed/ seen/
    out/
    archive/
  projects/<project-id>/
    clerk/
      mailbox/
      out/
      archive/
    knowledge/
      inbox/
      accepted/
      rejected/
    tickets/<task-id>.md
    agents/<role>/
      workdir/
      mailbox/
      out/<task-id>/
      archive/<task-id>.md
```

`clerk@<site>` 投到公司根的 `clerk/mailbox`。其他岗位投到 `projects/<项目>/agents/<角色>/mailbox`。只有一个项目时，路径可以不带 `projects/<id>/` 前缀；有多个项目时，`body` 必须以 `projects/<id>/` 开头。

默认 `company.yaml`：

```yaml
company: example
sites:
  - id: home
roles:
  - id: clerk
    kind: clerk
  - id: knowledge
    kind: knowledge
  - id: merge
    kind: merge
  - id: coder-ui
    kind: worker
projects:
  - id: site
```

`kind`：`clerk` 只传话；`knowledge` 只维护知识库；`worker` 接单执行；`merge` 是负责合并的 worker。v0 里 `merge` 和 `worker` 都跑同一个占位岗，不真正合并代码。身份写作 `role@site`，例如 `coder-ui@home`。

## 信封

```json
{
  "id": "env-20261112-014-01",
  "from": "clerk@home",
  "to": "coder-ui@home",
  "task_id": "task-20261112-014",
  "type": "dispatch",
  "priority": "normal",
  "body": "projects/site/tickets/task-20261112-014.md",
  "created_at": "2026-11-12T12:00:00+08:00"
}
```

任务单是带 YAML 头的 Markdown，至少要有目标、约束、输入。若写了 `knowledge`，每一项都只能指向 `knowledge/accepted/` 下面的文件。占位岗不读取这些文件的内容：没有知识引用时存档 `status: done`；有合法知识路径时存档 `status: needs-review`，遗留写明知识未核对。存档正文只有三行：结论、产物路径、遗留。

## 环境

需要 Node.js 22+。

```bash
npm install
npm test
npm run build
```

开发时也可以不构建，直接 `node src/cli.ts …` 或 `npm run opc -- …`。

## 本地演示

在仓库根目录执行。它会初始化 `demo-company`，写一张任务单，在后台监视 `mailbox/new`，投出一封 `dispatch`，等占位岗写好产物和存档，并把 `result-ready` 签收到 `done`。最后再投一次同一个 id，确认不会重做。

```bash
set -euo pipefail
npm install
npm run build
OPC="node ./dist/cli.js"

rm -rf demo-company
$OPC init demo-company

mkdir -p demo-company/projects/site/tickets
cat > demo-company/projects/site/tickets/task-20261112-014.md << 'EOF'
---
goal: 把首页标题改成「一人公司」
constraints:
  - 只改标题文案
  - 不新增依赖
inputs:
  - projects/site/tickets/task-20261112-014.md
---

标题改为「一人公司」。
EOF

$OPC watch --root demo-company --once &
watch_pid=$!

$OPC send --root demo-company \
  --id env-20261112-014-01 \
  --from clerk@home \
  --to coder-ui@home \
  --task-id task-20261112-014 \
  --type dispatch \
  --priority normal \
  --body projects/site/tickets/task-20261112-014.md

wait "$watch_pid"

echo "==== 存档 ===="
cat demo-company/projects/site/agents/coder-ui/archive/task-20261112-014.md

echo "==== 产物 ===="
cat demo-company/projects/site/agents/coder-ui/out/task-20261112-014/result.md

echo "==== 派单已完成 ===="
cat demo-company/projects/site/agents/coder-ui/mailbox/done/env-20261112-014-01.json

echo "==== 回执已签收 ===="
cat demo-company/clerk/mailbox/done/env-20261112-014-01--result-ready.json

echo "==== 重复投递 ===="
$OPC send --root demo-company \
  --id env-20261112-014-01 \
  --from clerk@home \
  --to coder-ui@home \
  --task-id task-20261112-014 \
  --type dispatch \
  --priority normal \
  --body projects/site/tickets/task-20261112-014.md
```

`--once` 会一直等到至少处理完一封信，并且所有被监视的 `new/` 和 `cur/` 都空了再退出。所以要先把 watch 放到后台，再 send。watch 若抢在 send 之前启动，靠文件 watch 叫醒；send 若抢先把信放进 `new/`，watch 启动时会把已经在队列里的信处理掉。

不带 `--once` 时，`opc watch` 停在前台，直到 Ctrl+C。

前台看某一个岗位：

```bash
node ./dist/cli.js watch --root demo-company --role coder-ui
```

这样只会叫醒该岗位。回执会留在 `clerk/mailbox/new/`，直到有人监视传话岗并把它签收进 `done/`。

## 协作约定

- 公司记的是任务单和短存档，不是会话树。
- 信封不进模型上下文。v0 没有模型，占位岗也只读 `body` 指向的那一张任务单。
- 传输和执行分开：`opc send` 只负责把信原子放进信箱。

## 许可

[MIT](LICENSE)
