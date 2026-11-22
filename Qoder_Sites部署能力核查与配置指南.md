# Qoder Sites 部署能力核查与密钥配置指南

> **生成时间**：2026-11-22（本地时间，Asia/Shanghai）
> **背景**：作者计划将「留影 Afterlight」部署到 Qoder Sites 公网链接（2026 Qoder 高校创造力大赛官方要求），部署前就环境变量/密钥安全配置提出 5 个问题。本文档为核查结论与配置指导。
> **核查依据**：Qoder 官方文档（docs.qoder.com/zh/cli/sites）+ 本机当前 Sites 插件运行时契约 + 项目真实代码/部署包 + `get_context` 实测。
> **本次性质**：只核查与说明，**未修改代码、未部署、未调用收费模型、未读取任何密钥值**。

---

## ⚠️ 最重要的发现：当前 stage 包不是 Qoder Sites 能运行的形态

对照三处权威来源，结论一致：

### 1. 官方文档定义的 Sites 形态

[docs.qoder.com/zh/cli/sites](https://docs.qoder.com/zh/cli/sites)：Qoder Sites 托管的是「**静态页面 + Server Functions + 数据库 + 对象存储**」，Secrets 在 `/sites` 面板管理（"环境变量（Secrets）：添加、替换与删除；值只写不可读回"）。

### 2. 本机当前 Sites 插件的运行时契约（原文）

`skills/sites-building/references/environment.md` 第 39 行：

> "Do not assume a Node server, framework SSR process, Cloudflare Worker binding or deployment-time package installation is available. The packager does not compile application source or resolve missing dependencies. **Framework applications must produce compatible static output and put required server behavior behind the Function.**"

即：**静态前端 + 一个 Deno 边缘函数（`index.ts` / `Deno.serve`）**，明确不假设存在 Node 长驻服务器。

`ensure_backend` 的后端能力枚举只有 `database / functions / storage / qoder`，**没有"服务器/容器"能力**。整个 Sites 插件中搜不到 `DATA_DIR`。

### 3. 当前 stage 包实际是为另一种平台准备的

`deploy-package/stage/start.sh` 第一行注释写的是 **"ZCode Sites 启动脚本"**，内容为：

- `exec node node_modules/next/dist/bin/next start -H 0.0.0.0 -p "$PORT"`
- 预装 linux x64 `node_modules`
- `$DATA_DIR` 数据目录 + 首次启动复制 seed
- `AFTERLIGHT_PUBLIC=1`

这是**容器式 PaaS**（长驻 Node 服务器 + 可写磁盘）的形态，**不是 Qoder Sites**。

### 两个实测事实

| 事实 | 证据 |
|---|---|
| **本目录从未向 Qoder Sites 准备/部署过任何站点** | `get_context` 返回 `sites: []`、`developmentSites: []` |
| **"已实测响应 200"是本机测试，不是 Sites 云端** | `docs/v3-acceptance.md` 所有 stage 测试均为临时目录 + 本机 Chrome + 本机 Mock，0 次真实模型、未发布公网 |

`docs/Afterlight_公网匿名会话版设计.md` 中假设的「`$DATA_DIR` 临时、512MB 磁盘、1GB 内存单实例」**都不是 Qoder Sites 的特性**。

### 结论

**`next start` / `node:sqlite` / `sharp` 原生二进制 / `start.sh` / `$DATA_DIR` 这套东西无法直接部署到 Qoder Sites。**

"开发完毕只剩部署"对 Sites 这个目标**不成立**——中间还差一个**移植阶段**。本届其它参赛队正是这么做的：StudyPilot 先做本地 Spring Boot + Vue 全栈，再"用 Qoder Sites 把核心闭环**移植到边缘函数**"才公开发布（S1–S5）。

---

## 逐条回答 5 个问题（基于 Sites 真实能力）

### 问题 1：是否支持环境变量/平台密钥？在哪里设？

**支持，叫"应用 Secrets"。**

- **操作位置**：Sites 站点设置里的「环境变量（Secrets）」（CLI 的 `/sites` 面板，或 Desktop 站点设置）。
- **流程**：
  1. 准备草稿时**只声明名称**（`prepare_site.secretNames`，如 `AI_API_KEY`）；
  2. 草稿就绪后**在设置界面填值**（专用安全输入，值只写不可读回）；
  3. 确认同步成功；
  4. 再发布依赖它的版本。
- **安全保证**：值不进聊天、日志、前端、构建产物、工具参数。
- ⚠️ **注入对象是边缘函数运行时**（函数里用 `Deno.env.get('AI_API_KEY')` 读），**不是 `next start` 进程**。

### 问题 2：直接部署整个项目文件夹，`.env.local` 会被上传/公开吗？

- `prepare_site` 只打包选定的**静态输出目录（webDirectory）+ 函数目录（functionDirectory）**。
- 规范明确要求把 `.env`、密钥、`node_modules`、源码**排除在包外**（deployment.md 原文："Keep source control, dependencies, `.env`, private keys, symlinks and local fixture servers outside the package."）。
- **如果**把含 `.env.local` 的目录当作静态输出上传，它**会变成一个可被公网直接下载的文件**——必须避免。
- Git 侧：项目 `.gitignore` 已排除 `.env` 与 `.env*.local`，不会进仓库。
- **根本问题**：整包上传 Next 服务器到 Sites 这条路不存在（见上方结论）。

### 问题 3：`AI_API_KEY` 哪种方式最安全？

**平台 Secrets（站点设置填值）是唯一推荐做法。**

| 方式 | 安全性 | 说明 |
|---|---|---|
| ✅ 平台 Secrets（站点设置） | 最安全 | 值只写不可读回，不进包/日志/前端 |
| ❌ 随包 `.env` 文件 | 危险 | 可能变成公网可下载文件 |
| ❌ 写进 `start.sh` | 危险 | 密钥进入脚本文件/上传产物 |
| ❌ `NEXT_PUBLIC_` 前缀 | 危险 | 直接打进浏览器 bundle |

本机开发阶段用服务端 `.env.local`（gitignore、无 `NEXT_PUBLIC_` 前缀）是安全的；一旦上 Sites，密钥只能走 **Secrets → 边缘函数**。

### 问题 4：部署后这些变量对 `next start` 是否可见？

**这个问题在 Sites 上不成立——Sites 上没有 `next start` 进程。**

Secrets 只对边缘函数可见（`Deno.env.get`）。要让应用跑起来，必须先把后端逻辑移植进函数。

### 问题 5：`$DATA_DIR` 重启后会清空吗？

**Sites 没有 `$DATA_DIR` 这个概念**，也没有给服务器进程的持久本地磁盘。

- 函数实例是临时的，任何本地文件写入都不保留。
- **持久化要用平台数据库（重启不丢）+ 对象存储 Storage（私有桶）**。
- 设计文档里"重启清空访客数据"的假设需改成"数据进平台数据库/Storage，按过期策略清理"。

---

## 顺带核实的两个小问题（非阻断项）

### start.sh 注释自相矛盾

- 头部写"只读展示站、写入一律 403"；
- 但又设了 `AFTERLIGHT_PUBLIC=1`（按 `src/lib/visitor/access.ts` 这是**完整访客版**，本会话写入会放行）。
- 实际行为以代码为准；头部"只读"注释是过时的。
- 脚本不设任何 Key → 访客目前只能用 Demo，真实 AI 要填 Key 后才可用。

### 模型与 env 组合没问题

- `deepseek-flash` 的视觉兼容已在 `docs/ai-setup.md` 第 56 行核对过官方文档（2026-11-20，支持 Base64 JPEG 输入；但真实联调仍未测）。
- `AFTERLIGHT_PUBLIC=1` + `AFTERLIGHT_ACCESS_MODE=local` 是设计预期组合（连接测试仅本机可用），不冲突。

---

## 移植对照表（若确认必须用 Sites）

| 现状（Node 服务器） | Sites 对应形态 | 难度 |
|---|---|---|
| Next SSR + Route Handlers | 静态前端输出 + 一个边缘函数承接 API | 中–高 |
| `node:sqlite` 本地库 | Sites 平台数据库（SQL 迁移） | 中 |
| `sharp` 原生图片处理 | 边缘函数跑不了 sharp → 客户端 canvas/wasm 预处理，或预生成 | 高 |
| `data/uploads` 文件 | 平台 Storage（私有桶 + 签名 URL） | 中 |
| 会话/额度/过期清理 | 数据库表 + 函数逻辑 | 中 |
| 离线 HTML 导出 | 函数生成或客户端生成 | 中 |
| Demo 浏览/放映/离线播放 | 纯前端，静态化即可 | 低 |

纯前端能力（Demo 浏览、放映、离线导出播放）静态化相对快；上传/AI/数据库这条链是移植重点。

---

## 待作者决定的方向

1. **大赛官方是否只认 Qoder Sites 公网链接？** 如果官方通知里描述了另一种"服务器托管"入口，请提供原文重新核对（当前结论基于官方文档 + 当前 Sites 插件，证据一致）。
2. 如果确实必须用 Sites，是否先做一份**"移植可行性评估 + 分阶段计划"**（不改代码），评估工作量、哪些能复用、sharp/上传怎么替代，再逐阶段经作者同意后实施？

**密钥始终由作者本人在本机/站点设置填写，不进聊天。**

---

## 参考来源

- [Sites 站点构建与托管 — Qoder 官方文档](https://docs.qoder.com/zh/cli/sites)
- [「2026 Qoder 高校创造力大赛」StudyPilot AI（本地全栈 → 移植边缘函数发布）](https://tianchi.aliyun.com/forum/post/1102981)
- [【StudyHack】职构 ResumeCraft（静态站点 + 云函数 + 数据库 + Secrets）](https://tianchi.aliyun.com/forum/post/1098755)
- [我用 Qoder Sites 把全栈工具站点部署上线了 — 51CTO](https://www.51cto.com/article/856716.html)
- 本机 Sites 插件：`skills/sites-building/references/environment.md`、`functions.md`；`skills/sites-hosting/references/deployment.md`
- 项目文件：`deploy-package/stage/start.sh`、`docs/Afterlight_公网匿名会话版设计.md`、`docs/ai-setup.md`、`docs/v3-acceptance.md`、`src/lib/ai/config.ts`、`src/lib/visitor/access.ts`