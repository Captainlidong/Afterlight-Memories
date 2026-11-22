# Qoder 边缘代理部署任务书 — 静态层 v2 + 边缘函数（反向代理）

> **给 Qoder 执行**：把「留影 Afterlight」的部署形态升级为**全站同源**——访客浏览器全程只见 Qoder Sites 域名，
> 创作层流量由 Sites 边缘函数反向代理转发到作者自有服务器。服务器地址作为应用 Secret 由作者在站点设置中填写，
> **本文档与部署包均不包含任何服务器地址或密钥**。
> 更新时间：2026-11-22 · 作者：Captainlidong

---

## 一、升级后的部署形态

```
浏览器（地址栏 / 网络面板全程只有 Qoder Sites 域名）
 ├─ /                       → 静态落地页 index.html（本次更新：「开始创作我的影展」卡片改为站内链接）
 ├─ /demo-exhibition.html   → 静态示例影展（不变，不经函数）
 └─ /functions/v1/app/**    → 边缘函数（本任务新增，反向代理）→ 转发到作者创作层服务器
```

- 边缘函数已在本机完成全链路实测（路径归一化 + 转发头 + Cookie 透传 + 流式响应），
  **请勿修改其代码逻辑**——归一化规则与源站 basePath 形态严格对应。
- 源站已按同形态升级完毕（作者完成，前置条件），转发即可工作。

## 二、部署物（共 2 处，均在本项目目录内）

| 位置 | 内容 | 说明 |
|---|---|---|
| `qoder-sites-static/`（webDirectory） | `index.html`（~5KB）+ `demo-exhibition.html`（~3MB） | 落地页卡片链接已改为站内 `/functions/v1/app/create`；示例影展完全自包含，断网可放映 |
| `edge-function/`（functionDirectory） | `index.ts`（Deno.serve 入口）+ `proxyPath.ts`（路径归一化纯函数） | 零依赖、自包含；相对导入带显式扩展名，符合 Sites 函数打包契约 |

## 三、Qoder 需要执行的任务

1. **更新站点**（复用现有站点与 projectId，不新建）：
   - `webDirectory` = `qoder-sites-static/`（含 index.html）
   - `functionDirectory` = `edge-function/`
   - `secretNames` = `["AFTERLIGHT_ORIGIN_URL", "AFTERLIGHT_PROXY_TOKEN"]`（**只声明名称，不填值**）
   - `spa` = false（静态站无 SPA fallback 需求）
   - 不声明数据库 / 存储能力（本函数不使用）
2. **等待函数后端就绪**后暂停，通知作者在站点设置中填写两个 Secret 值：
   - `AFTERLIGHT_ORIGIN_URL`：作者创作层地址（作者持有，形如 `http://<地址>:3000`）
   - `AFTERLIGHT_PROXY_TOKEN`：与作者源站 `.env.server` 中相同的随机令牌（作者生成）
   - **Secret 值由作者本人通过站点设置的安全输入填写**，不经过聊天、命令行或本文档
3. 作者确认 Secret 同步成功后，**发布**新版本。

## 四、验收清单（Qoder 完成后自查，作者也会复核）

1. `https://<站点域名>/` 落地页 200，两张卡片可见；
2. 「开始创作我的影展」卡片链接为站内 `/functions/v1/app/create`（检查页面源码确认无任何外部 IP / 跨域地址）；
3. `/demo-exhibition.html` 200，放映控件可用；
4. `/functions/v1/app/api/health` 返回 `{"ok":true,"mode":"demo",...}`（经函数转发，说明 Secret 与代理链路就绪）；
5. 点击创作卡片 → 同域进入创作页（地址栏无任何跳转外部地址）；
6. （作者复核项）真实照片上传（单张 ~10MB）与完整策展流程、导出下载——由作者在发布后执行。

## 五、明确不在 Qoder 任务范围内的事项

- **不涉及任何密钥/Secrets 值**：两个 Secret 的值全部由作者在站点设置填写
- **不需要**配置数据库、对象存储
- **不要**修改 `edge-function/` 内的代码（含 `proxyPath.ts` 的归一化规则）与静态页内链接
- **不要**改动作者自有服务器上的任何内容（作者已自行升级完毕）

## 六、异常处理

- 若函数日志显示 `service_not_configured`：说明 `AFTERLIGHT_ORIGIN_URL` Secret 未填或未同步——等作者确认后再验收第 4 条；
- 若源站不可达：函数会返回 502（`upstream_unreachable`），属源站侧问题，通知作者处理；
- 若验收 5/6 出现资源 404：说明路径前缀与源站 basePath 不匹配，**不要**改函数代码，通知作者核对。

---

*本任务完成后，「留影 Afterlight」全站同源形态即生效：访客从落地页到创作、放映、导出的每一个请求都发生在 Qoder Sites 域名之下。*
